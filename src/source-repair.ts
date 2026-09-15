import { loadPrompt } from './prompts.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProvider } from './agents.js';
import type { ExecutionSummary, GauntletConfig, HealAudit, NormalizedContract, TestPlan } from './types.js';
import { atomicWrite, ensureWithin, sha256, stableStringify } from './utils.js';
import { redactAgentData } from './agent-redaction.js';
import { FIXTURE_OBSERVATION_GUIDE } from './fixtures.js';

type RepairConfig = NonNullable<GauntletConfig['sourceRepair']>;
export interface SourceEdit { path: string; oldText: string; newText: string; occurrence?: number; }

export async function sourceFiles(config: RepairConfig): Promise<Record<string, string>> {
  const root = await realpath(config.root);
  const files: Record<string, string> = {}; let bytes = 0;
  const visit = async (candidate: string): Promise<void> => {
    const file = ensureWithin(root, candidate);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('SOURCE_REPAIR_SYMLINK_DENIED');
    ensureWithin(root, await realpath(file));
    const relative = path.relative(root, file);
    if (relative.split(path.sep).some(part => /^(?:\.|tests?$|node_modules$|dist$|migrations?$)/i.test(part))) return;
    if (/(?:^|\/)(?:config|settings|secrets|credentials)(?:\/|\.(?:py|[cm]?js|ts)$)/i.test(relative)) return;
    if (info.isDirectory()) { for (const name of (await readdir(file)).sort()) await visit(path.join(file, name)); return; }
    if (!/\.(?:py|ts|js|mjs|go|java|cs|rb)$/i.test(file) || /(?:\.test|\.spec)\./i.test(file)) return;
    bytes += info.size;
    if (bytes > 300_000 || Object.keys(files).length >= 200) throw new Error('SOURCE_REPAIR_INPUT_LIMIT: narrow sourceRepair.include');
    files[relative] = await readFile(file, 'utf8');
  };
  for (const include of config.include) await visit(path.resolve(root, include));
  return files;
}

export async function runSourceCommand(command: string[], root: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  if (!command.length) throw new Error('SOURCE_COMMAND_EMPTY');
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let timedOut = false;
    const collect = (chunk: Buffer) => { if (output.length < 100_000) output += chunk.toString().slice(0, 100_000 - output.length); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: timedOut ? 124 : code ?? 1, output: String(redactAgentData(output)) }); });
  });
}

// Exact-match patches preserve pre-existing developer changes. Validate the whole
// proposal before any write; keep originals private for rollback and reject races.
export async function applySourceEdits(config: RepairConfig, original: Record<string, string>, edits: SourceEdit[], evidenceDir: string): Promise<{ before: Record<string, string>; after: Record<string, string> }> {
  if (!edits.length || edits.length > 20) throw new Error('SOURCE_REPAIR_EMPTY_OR_EXCESSIVE');
  const replacements = new Map<string, string>();
  const segments = new Map<string, Array<{start:number;end:number;text:string}>>();
  const root = await realpath(config.root);
  for (const edit of edits) {
    if (!edit || typeof edit.path !== 'string' || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string' || !edit.oldText || edit.oldText === edit.newText) throw new Error('SOURCE_REPAIR_EDIT_INVALID');
    if (!Object.hasOwn(original, edit.path)) throw new Error('SOURCE_REPAIR_FILE_DENIED');
    if (/\[REDACTED[^\]]*\]/.test(edit.newText + edit.oldText)) throw new Error('SOURCE_REPAIR_REDACTED_PATCH');
    const before = original[edit.path]!;
    const positions: number[] = [];
    for (let at = before.indexOf(edit.oldText); at >= 0; at = before.indexOf(edit.oldText,at + edit.oldText.length)) positions.push(at);
    if (edit.occurrence === undefined && positions.length !== 1) throw new Error(`SOURCE_REPAIR_ANCHOR_NOT_UNIQUE: ${edit.path}; matched ${positions.length} occurrences. Include unique class/function context or select an explicit zero-based occurrence.`);
    const occurrence = edit.occurrence ?? 0;
    if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= positions.length) throw new Error(`SOURCE_REPAIR_OCCURRENCE_INVALID: ${edit.path}; ${positions.length} exact matches available`);
    const file = ensureWithin(root, path.resolve(root, edit.path));
    if (await realpath(file) !== file || (await lstat(file)).isSymbolicLink()) throw new Error('SOURCE_REPAIR_SYMLINK_DENIED');
    if (await readFile(file, 'utf8') !== before) throw new Error('SOURCE_REPAIR_CONCURRENT_EDIT');
    const start = positions[occurrence]!; const end = start + edit.oldText.length;
    const existing = segments.get(edit.path) ?? [];
    if (existing.some(part => start < part.end && end > part.start)) throw new Error('SOURCE_REPAIR_OVERLAPPING_EDITS');
    existing.push({start,end,text:edit.newText}); segments.set(edit.path,existing);
  }
  for (const [name, edits] of segments) {
    let after = original[name]!;
    for (const edit of edits.sort((a,b)=>b.start-a.start)) after=after.slice(0,edit.start)+edit.text+after.slice(edit.end);
    replacements.set(name,after);
  }
  await mkdir(path.join(evidenceDir, 'originals'), { recursive: true, mode: 0o700 });
  const beforeHashes: Record<string, string> = {}; const afterHashes: Record<string, string> = {};
  for (const [name, after] of replacements) {
    const backup = path.join(evidenceDir, 'originals', name);
    await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    const handle = await open(backup, 'wx', 0o600);
    try { await handle.writeFile(original[name]!); } finally { await handle.close(); }
    beforeHashes[name] = sha256(original[name]!); afterHashes[name] = sha256(after);
  }
  const written: string[] = [];
  try {
    for (const [name, after] of replacements) {
      const target = path.join(root, name);
      if (await readFile(target, 'utf8') !== original[name]) throw new Error('SOURCE_REPAIR_CONCURRENT_EDIT');
      await atomicWrite(target, after); written.push(name);
    }
  } catch (error) {
    for (const name of written) if (sha256(await readFile(path.join(root, name))) === afterHashes[name]) await atomicWrite(path.join(root, name), original[name]!);
    throw error;
  }
  return { before: beforeHashes, after: afterHashes };
}

export async function repairSource(provider: AgentProvider, config: GauntletConfig, contract: NormalizedContract, plan: TestPlan, execution: ExecutionSummary, iteration: number, evidenceDir: string, feedback?: unknown): Promise<HealAudit> {
  const repair = config.sourceRepair;
  if (!repair) throw new Error('SOURCE_REPAIR_NOT_CONFIGURED');
  const root = await realpath(repair.root);
  const lockPath = path.join(root, '.gauntlet-source-repair.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(stableStringify({ pid: process.pid, evidenceDir }));
    const files = await sourceFiles(repair);
    const reply = await provider.invoke('developer', config.agents.healerModel ?? config.agents.builderModel,
      loadPrompt('developer'),
      { files, contract: contract.document, plan: {...plan,discovery:undefined}, execution, feedback,
        fixtureCapabilities: config.fixtures ? { observations:FIXTURE_OBSERVATION_GUIDE,
          deployment: repair.restartCommand.some(arg=>path.basename(arg)==='local-source-restart.js') ? 'The local deployment sets IMAGE_FETCH_ALLOWED_ORIGINS=http://127.0.0.1:9083. This is the configured permitted image origin. Port 9084 is a forbidden internal sentinel. Implement normal configurable origin policy; never bypass validation or add test-only response branches.' : undefined } : undefined });
    const output = reply.output as { hypothesis: string; edits: SourceEdit[] };
    if (!output || typeof output.hypothesis !== 'string' || !Array.isArray(output.edits)) throw new Error('SOURCE_REPAIR_OUTPUT_INVALID');
    await atomicWrite(path.join(evidenceDir, 'proposal.json'), stableStringify(redactAgentData(output)));
    const audit: HealAudit = { iteration, classification: 'product-defect', policyDecision: 'denied', hypothesis: output.hypothesis, changedFiles: [], beforeHashes: {}, afterHashes: {}, rollback: false, diffPath: path.join(evidenceDir, 'proposal.json') };
    if (!output.edits.length) return audit;
    const hashes = await applySourceEdits(repair, files, output.edits, evidenceDir);
    audit.changedFiles = Object.keys(hashes.after); audit.beforeHashes = hashes.before; audit.afterHashes = hashes.after;
    const commands: unknown[] = [];
    const command = async (stage: string, argv: string[]) => {
      const started = Date.now();
      console.error(`[source-repair] ${stage}: started`);
      const heartbeat = setInterval(() => console.error(`[source-repair] ${stage}: still running (${Math.round((Date.now()-started)/1000)}s)`), 30_000);
      try {
        const result = await runSourceCommand(argv, root, repair.commandTimeoutMs);
        console.error(`[source-repair] ${stage}: ${result.exitCode === 0 ? 'completed' : `failed (exit ${result.exitCode})`} in ${((Date.now()-started)/1000).toFixed(1)}s`);
        commands.push({stage,...result}); return result;
      } finally { clearInterval(heartbeat); }
    };
    try {
      const verify = await command('verify', repair.verifyCommand);
      if (verify.exitCode !== 0) throw new Error('SOURCE_REPAIR_VERIFICATION_FAILED');
      const restart = await command('restart', repair.restartCommand);
      if (restart.exitCode !== 0) throw new Error('SOURCE_REPAIR_RESTART_FAILED');
      audit.policyDecision = 'auto';
    } catch (error) {
      for (const name of audit.changedFiles) {
        if (sha256(await readFile(path.join(root, name))) !== hashes.after[name]) throw new Error('SOURCE_REPAIR_ROLLBACK_CONCURRENT_EDIT');
        await atomicWrite(path.join(root, name), files[name]!);
      }
      audit.rollback = true;
      const restart = await runSourceCommand(repair.restartCommand, root, repair.commandTimeoutMs).catch(() => ({ exitCode: 1, output: 'Rollback restart failed' }));
      commands.push({ stage: 'rollback-restart', ...restart });
      audit.hypothesis += `; ${error instanceof Error ? error.message : 'verification failed'}; source restored${restart.exitCode ? ', service restart failed' : ''}`;
    } finally { await atomicWrite(path.join(evidenceDir, 'validation.json'), stableStringify(commands)); }
    await atomicWrite(path.join(evidenceDir, 'audit.json'), stableStringify(audit));
    return audit;
  } finally { await lock.close(); await unlink(lockPath); }
}
