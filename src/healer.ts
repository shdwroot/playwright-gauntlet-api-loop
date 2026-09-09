import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GauntletConfig, HealAudit, TestPlan } from './types.js';
import { generateArtifacts, verifyGeneratedArtifacts } from './generator.js';
import { atomicWrite, sha256, stableStringify } from './utils.js';

async function fileState(config: GauntletConfig): Promise<{ hashes: Record<string, string>; contents: Record<string, string> }> {
  const files = ['plan.generated.json', 'api.generated.spec.mjs', 'manifest.json'];
  const hashes: Record<string, string> = {};
  const contents: Record<string, string> = {};
  for (const file of files) {
    try {
      const content = await readFile(path.join(config.generatedDir, file), 'utf8');
      contents[file] = content;
      hashes[file] = sha256(content);
    } catch {
      contents[file] = '';
      hashes[file] = 'missing';
    }
  }
  return { hashes, contents };
}

function compactDiff(before: Record<string, string>, after: Record<string, string>): string {
  const lines: string[] = [];
  for (const file of Object.keys(after).sort()) {
    if (before[file] === after[file]) continue;
    const oldLines = (before[file] ?? '').split('\n');
    const newLines = (after[file] ?? '').split('\n');
    let first = 0;
    while (oldLines[first] === newLines[first] && first < oldLines.length && first < newLines.length) first += 1;
    lines.push(`--- ${file} before`, `+++ ${file} regenerated`, `@@ first changed line ${first + 1} @@`, `- ${oldLines[first] ?? '<missing>'}`, `+ ${newLines[first] ?? '<missing>'}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function healGeneratedArtifacts(trustedPlan: TestPlan, config: GauntletConfig, iteration: number, auditDir: string): Promise<HealAudit> {
  const before = await fileState(config);
  const trustedContents = stableStringify(trustedPlan);
  const currentPlan = before.contents['plan.generated.json'] ?? '';
  const integrity = await verifyGeneratedArtifacts(config).catch(() => ({ valid: false, mismatches: ['manifest missing or corrupt'] }));
  if (currentPlan === trustedContents && integrity.valid) {
    return {
      iteration,
      classification: 'product-contract-or-infrastructure-failure',
      policyDecision: 'denied',
      hypothesis: 'The signed candidate already matches the immutable contract; changing expectations would conceal a real failure.',
      changedFiles: [],
      beforeHashes: before.hashes,
      afterHashes: before.hashes,
      rollback: false,
    };
  }

  await generateArtifacts(trustedPlan, config);
  const after = await fileState(config);
  const changedFiles = Object.keys(after.hashes).filter((file) => before.hashes[file] !== after.hashes[file]);
  const forbidden = changedFiles.filter((file) => !['plan.generated.json', 'api.generated.spec.mjs', 'manifest.json'].includes(file));
  if (forbidden.length > 0) throw new Error(`HEAL_SCOPE_VIOLATION: ${forbidden.join(', ')}`);
  const verification = await verifyGeneratedArtifacts(config);
  if (!verification.valid) throw new Error(`HEAL_INTEGRITY_FAILED: ${verification.mismatches.join('; ')}`);
  const diffPath = path.join(auditDir, `heal-${iteration}.diff`);
  await atomicWrite(diffPath, compactDiff(before.contents, after.contents));
  return {
    iteration,
    classification: 'generated-candidate-drift',
    policyDecision: 'auto',
    hypothesis: 'The candidate differed from the deterministic plan compiled from the current immutable OpenAPI contract.',
    changedFiles,
    beforeHashes: before.hashes,
    afterHashes: after.hashes,
    diffPath,
    rollback: false,
  };
}

export async function injectStaleGeneratedData(config: GauntletConfig): Promise<string> {
  const planPath = path.join(config.generatedDir, 'plan.generated.json');
  const manifestPath = path.join(config.generatedDir, 'manifest.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as TestPlan;
  const target = plan.cases.find((testCase) => testCase.operationId === 'createUser' && testCase.kind === 'positive');
  if (!target || !target.body || typeof target.body !== 'object') throw new Error('FAULT_INJECTION_UNAVAILABLE: no createUser positive body');
  target.body = { ...(target.body as Record<string, unknown>), name: '' };
  const planContents = stableStringify(plan);
  await atomicWrite(planPath, planContents);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown> & { files: Record<string, string> };
  manifest.planHash = sha256(planContents);
  manifest.files['plan.generated.json'] = sha256(planContents);
  await atomicWrite(manifestPath, stableStringify(manifest));
  return target.id;
}
