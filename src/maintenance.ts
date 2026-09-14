import type { CoverageBacklog } from './coverage.js';
import { mkdir, open, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateSources } from './discovery.js';
import { optionalJson, writeAnalysisReport } from './analysis-report.js';
import type { GauntletConfig, RunResult, TestPlan } from './types.js';
import { atomicWrite, sha256, stableStringify } from './utils.js';
import { originalContextFiles } from './onboarding.js';

export interface ContextSnapshot { revision: string; frameworkHash: string; files: Array<{ path: string; hash: string }>; }

export async function snapshotContext(config: GauntletConfig, configPath?: string): Promise<ContextSnapshot> {
  const sources = config.discovery.enabled ? await enumerateSources(config) : [];
  const paths = [...new Set([config.spec, ...sources.map(source => source.absolutePath), ...(configPath ? [path.resolve(configPath)] : [])])].sort();
  let total = 0;
  const root = await realpath(config.projectRoot);
  const files = [];
  for (const file of paths) {
    const size = (await stat(file)).size;
    if (size > config.discovery.maxFileBytes) throw new Error(`CONTEXT_FILE_LIMIT: ${file}`);
    total += size;
    if (total > config.discovery.maxTotalBytes) throw new Error('CONTEXT_TOTAL_LIMIT');
    files.push({ path: path.relative(root, await realpath(file)), hash: sha256(await readFile(file)) });
  }
  if (configPath) files.push(...await originalContextFiles(configPath));
  const frameworkDir = path.dirname(fileURLToPath(import.meta.url));
  const modules = (await readdir(frameworkDir)).filter(file => /\.(?:js|ts)$/.test(file) && !file.endsWith('.d.ts')).sort();
  const framework = await Promise.all(modules.map(async file => ({ file, hash: sha256(await readFile(path.join(frameworkDir, file))) })));
  const frameworkHash = sha256(stableStringify(framework));
  return { revision: sha256(stableStringify({ files, config, frameworkHash })), frameworkHash, files };
}

export function contextChanges(previous: ContextSnapshot | undefined, current: ContextSnapshot) {
  const old = new Map(previous?.files.map(file => [file.path, file.hash]));
  const next = new Map(current.files.map(file => [file.path, file.hash]));
  return { added: [...next.keys()].filter(file => !old.has(file)),
    changed: [...next.keys()].filter(file => old.has(file) && old.get(file) !== next.get(file)),
    removed: [...old.keys()].filter(file => !next.has(file)) };
}

export async function withRunLock<T>(generatedDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(generatedDir, { recursive: true });
  const lockPath = path.join(generatedDir, '.maintenance.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`RUN_ALREADY_ACTIVE: ${lockPath}; if a process crashed, verify it has stopped before removing this lock`);
    throw error;
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}

interface MaintenanceState { formatVersion: 1; context: ContextSnapshot; runId: string; status: RunResult['status']; reportPath: string; }

export async function maintainRun(config: GauntletConfig, configPath: string | undefined, execute: (previousPlan?: TestPlan, previousBacklog?: CoverageBacklog) => Promise<RunResult>): Promise<RunResult> {
  return withRunLock(config.generatedDir, async () => {
    const before = await snapshotContext(config, configPath);
    const stateDir = path.join(config.artifactsDir, '.maintenance', sha256(config.generatedDir).slice(0, 16));
    const statePath = path.join(stateDir, 'latest.json');
    const previous = await optionalJson<MaintenanceState>(statePath);
    const savedPath = path.join(stateDir, 'validated-plan.json');
    const saved = await optionalJson<{ revision: string; hash: string; plan: TestPlan }>(savedPath);
    if (saved && sha256(stableStringify(saved.plan)) !== saved.hash) throw new Error('PERSISTED_PLAN_INTEGRITY_FAILED');
    const checkpointPath = path.join(stateDir, 'candidate-plan.json');
    const checkpoint = await optionalJson<{ revision: string; hash: string; plan: TestPlan }>(checkpointPath);
    if (checkpoint && sha256(stableStringify(checkpoint.plan)) !== checkpoint.hash) throw new Error('PERSISTED_PLAN_INTEGRITY_FAILED');
    // A failed execution can still contain a useful compiled implementation.
    // It is input to the builder, never a passing result or permission to skip gates.
    const validated = saved?.revision === before.revision ? saved : undefined;
    const draft = checkpoint?.revision === before.revision ? checkpoint : undefined;
    const candidate = draft && draft.hash !== validated?.hash ? draft : validated ?? draft;
    const reusable = config.agents.provider === 'openai' ? candidate?.plan : undefined;
    const backlogPath = path.join(stateDir, 'coverage-backlog.json');
    const previousBacklog = await optionalJson<CoverageBacklog>(backlogPath);
    const result = await execute(reusable, previousBacklog);
    let after: ContextSnapshot | undefined;
    let contextError: string | undefined;
    try { after = await snapshotContext(config, configPath); }
    catch (error) { contextError = error instanceof Error ? error.message : String(error); }
    if (!after || after.revision !== before.revision) {
      if (result.coverage) for (const obligation of result.coverage.obligations) { obligation.status = 'needs-review'; obligation.proofs = []; }
      result.status = 'BLOCKED';
      result.findings.push({ code: 'CONTEXT_CHANGED_DURING_RUN', severity: 'blocking',
        message: 'Context changed during execution. This result cannot certify the current revision; a fresh run is required.', evidence: [before.revision, after?.revision ?? contextError ?? 'unavailable'] });
      result.events.push({ sequence: result.events.length + 1, at: new Date().toISOString(), state: 'BLOCKED', iteration: result.iterations, detail: 'Context revision invalidated after execution' });
    }
    if (result.coverage) {
      await atomicWrite(backlogPath, stableStringify(result.coverage));
      await atomicWrite(path.join(result.runDir, 'coverage-backlog.json'), stableStringify(result.coverage));
    }
    const metadata = { ...before, previousRunId: previous?.runId, reusedValidatedPlan: Boolean(reusable && candidate === saved),
      resumedCandidatePlan: Boolean(reusable && candidate === checkpoint),
      changes: contextChanges(previous?.context, before), stableDuringRun: after?.revision === before.revision };
    await atomicWrite(path.join(result.runDir, 'context.json'), stableStringify(metadata));
    await atomicWrite(path.join(result.runDir, 'result.json'), stableStringify(result));
    await atomicWrite(path.join(result.runDir, 'events.json'), stableStringify(result.events));
    const analysis = await writeAnalysisReport(result, metadata);
    await atomicWrite(path.join(result.runDir, 'scenario-ledger.json'), stableStringify(analysis.scenarios));
    const state: MaintenanceState = { formatVersion: 1, context: before, runId: result.runId, status: result.status, reportPath: analysis.reportPath };
    await atomicWrite(path.join(stateDir, 'history', `${result.runId}.json`), stableStringify(state));
    await atomicWrite(statePath, stableStringify(state));
    if (after?.revision === before.revision) {
      const plan = await optionalJson<TestPlan>(path.join(result.runDir, 'plan.json'));
      if (plan) {
        const entry = stableStringify({ revision: before.revision, hash: sha256(stableStringify(plan)), plan });
        await atomicWrite(checkpointPath, entry);
        if (result.status === 'PASSED') await atomicWrite(savedPath, entry);
      }
    }
    return result;
  });
}

export async function watchRevisions(options: {
  revision: () => Promise<string>;
  execute: () => Promise<void>;
  signal: AbortSignal;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): Promise<void> {
  let completed: string | undefined;
  let pending: string | undefined;
  let initial = true;
  while (!options.signal.aborted) {
    try {
      const revision = await options.revision();
      if (options.signal.aborted) break;
      // Require two matching observations for changes, to coalesce editor saves.
      if (initial || (revision !== completed && revision === pending)) {
        initial = false;
        completed = revision; // Do not repeatedly spend model calls on an unchanged revision after an error.
        await options.execute(); // Serialized: never overlap runs or generated artifacts.
      }
      pending = revision;
    } catch (error) { options.onError?.(error); }
    if (options.signal.aborted) break;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, options.intervalMs ?? 1500);
      options.signal.addEventListener('abort', finish, { once: true });
    });
  }
}
