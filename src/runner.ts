import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionSummary, GauntletConfig } from './types.js';
import { redactAgentData } from './agent-redaction.js';
import { atomicWrite, sha256 } from './utils.js';

interface PlaywrightResult { status?: string; startTime?: string; error?: { message?: string }; errors?: Array<{ message?: string }>; attachments?: Array<{ name?: string; body?: string }> }
interface PlaywrightTest { title?: string; expectedStatus?: string; results?: PlaywrightResult[] }
interface PlaywrightSpec { title?: string; tests?: PlaywrightTest[] }
interface PlaywrightSuite { specs?: PlaywrightSpec[]; suites?: PlaywrightSuite[] }
interface PlaywrightReport { suites?: PlaywrightSuite[] }

function allTests(suites: PlaywrightSuite[]): PlaywrightTest[] {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => (spec.tests ?? []).map((test) => ({ ...test, title: spec.title ?? test.title ?? 'unknown' }))),
    ...allTests(suite.suites ?? []),
  ]);
}

export function summarizePlaywrightReport(report: PlaywrightReport, exitCode: number, combinedOutput: string, paths: Pick<ExecutionSummary, 'reportPath' | 'stdoutPath' | 'stderrPath'>, durationMs: number): ExecutionSummary {
  const tests = allTests(report.suites ?? []);
  const statuses = tests.map((test) => test.results?.at(-1)?.status ?? test.expectedStatus ?? 'unknown');
  const failures = tests.flatMap((test) => test.results ?? []).filter((result) => result.status === 'failed' || result.status === 'timedOut');
  const messages = failures.flatMap((result) => [result.error?.message, ...(result.errors ?? []).map((error) => error.message)]).filter((message): message is string => Boolean(message));
  const infrastructure = /TARGET_UNREACHABLE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(combinedOutput);
  let observationCharacters = 0;
  const observations = tests.map(test => {
    const result = test.results?.at(-1);
    return { title: test.title ?? 'unknown', status: result?.status ?? 'unknown',
      ...(result?.startTime ? { startedAt: result.startTime } : {}),
      exchanges: (result?.attachments ?? []).filter(attachment => attachment.name?.endsWith('-exchange.json') && attachment.body).slice(0, 20).map(attachment => {
        if (observationCharacters >= 100_000) return { unavailable: 'Observation budget exhausted; inspect the full Playwright report.' };
        try {
          const exchange = redactAgentData(JSON.parse(Buffer.from(attachment.body!, 'base64').toString('utf8'))) as Record<string, unknown>;
          const compact = (value: unknown) => {
            const text = JSON.stringify(value);
            return text && text.length > 2000 ? { truncated: true, preview: text.slice(0, 2000) } : value;
          };
          const observation = { request: compact(exchange.request), response: compact(exchange.response) };
          observationCharacters += JSON.stringify(observation).length;
          return observation;
        } catch { return { unavailable: 'Exchange could not be decoded.' }; }
      }),
    };
  }).sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
  return {
    exitCode,
    status: exitCode === 0
      ? 'passed'
      : infrastructure ? 'infrastructure-failed' : tests.length > 0 ? 'test-failed' : 'framework-failed',
    tests: tests.length,
    passed: statuses.filter((status) => status === 'passed').length,
    failed: statuses.filter((status) => status === 'failed' || status === 'timedOut').length,
    skipped: statuses.filter((status) => status === 'skipped').length,
    durationMs,
    ...paths,
    observations: observations.slice(0, 200),
    observationsOmitted: Math.max(0, observations.length - 200),
    failures: tests.filter((test) => test.results?.some((result) => result.status === 'failed' || result.status === 'timedOut')).slice(0, 50).map((test) => ({
      title: test.title ?? 'unknown',
      messages: (test.results ?? []).flatMap((result) => [result.error?.message, ...(result.errors ?? []).map((error) => error.message)])
        .filter((value): value is string => Boolean(value)).map((value) => String(redactAgentData(value.slice(0, 6000)))),
      exchanges: (test.results ?? []).flatMap((result) => result.attachments ?? []).filter((attachment) => attachment.name?.endsWith('-exchange.json') && attachment.body)
        .slice(0, 10).map((attachment) => {
          try { return redactAgentData(JSON.parse(Buffer.from(attachment.body!, 'base64').toString('utf8').slice(0, 65_536))); }
          catch { return { unavailable: 'Exchange could not be decoded within evidence limit.' }; }
        }),
    })),
    failureFingerprints: [...new Set(messages.map((message) => sha256(message.replace(/\d+ms/g, '<time>')).slice(0, 16)))],
  };
}

export async function runPlaywright(config: GauntletConfig, runId: string, attemptDir: string): Promise<ExecutionSummary> {
  await mkdir(attemptDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('@playwright/test/package.json');
  const cliPath = path.join(path.dirname(packagePath), 'cli.js');
  const configPath = path.resolve('playwright.config.mjs');
  const stdoutPath = path.join(attemptDir, 'stdout.log');
  const stderrPath = path.join(attemptDir, 'stderr.log');
  const reportPath = path.join(attemptDir, 'playwright-report.json');
  const env = {
    ...process.env,
    GAUNTLET_BASE_URL: config.baseUrl,
    GAUNTLET_GENERATED_DIR: config.generatedDir,
    GAUNTLET_ATTEMPT_DIR: attemptDir,
    GAUNTLET_HEADER_ENV_MAP: JSON.stringify(config.headersFromEnv),
    GAUNTLET_MAX_RESPONSE_BYTES: String(config.safety.maxResponseBytes),
    GAUNTLET_TEST_TIMEOUT_MS: String(config.timeoutMs),
    GAUNTLET_RUN_ID: runId,
  };
  const started = Date.now();
  const result = await new Promise<{ code: number }>((resolve) => {
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    const child = spawn(process.execPath, [cliPath, 'test', '--config', configPath], { cwd: process.cwd(), env, stdio: ['ignore', stdoutFd, stderrFd] });
    // Test timeout is per case. Collection and reporters can be slow on a cold
    // Playwright start, so the orchestration watchdog must be a separate budget.
    const suiteTimeoutMs = Math.max(180_000, config.timeoutMs * 2);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, suiteTimeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      closeSync(stdoutFd);
      closeSync(stderrFd);
      resolve({ code: code ?? 1 });
    });
  });
  const stdout = await readFile(stdoutPath, 'utf8').catch(() => '');
  const stderr = await readFile(stderrPath, 'utf8').catch(() => '');
  let report: PlaywrightReport = {};
  try { report = JSON.parse(await readFile(reportPath, 'utf8')) as PlaywrightReport; } catch { /* classified below */ }
  return summarizePlaywrightReport(report, result.code, `${stdout}\n${stderr}`, { reportPath, stdoutPath, stderrPath }, Date.now() - started);
}
