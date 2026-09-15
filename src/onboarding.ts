import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadContract } from './openapi.js';
import { sha256, stableStringify, atomicWrite } from './utils.js';
import { discoverSourceProject, discoverFixtures } from './source-project.js';

export interface OnboardingOptions {
  url: string;
  context: string[];
  directory?: string | undefined;
  model?: string | undefined;
  allowProduction?: boolean;
  source?: string | undefined;
}

// This is application transport, not agent-authored browsing. Never follow a
// contract redirect to a different service or interpret its text as instructions.
export async function fetchContract(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json, application/yaml, text/yaml' } });
  if (!response.ok) throw new Error(`ONBOARDING_CONTRACT_HTTP: ${response.status}`);
  if (!response.body) throw new Error('ONBOARDING_EMPTY_CONTRACT');
  const chunks: Uint8Array[] = []; let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 5_242_880) throw new Error('ONBOARDING_CONTRACT_TOO_LARGE');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function onboard(options: OnboardingOptions): Promise<string> {
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('ONBOARDING_URL_INVALID');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local && !options.allowProduction) throw new Error('ONBOARDING_REMOTE_TARGET: supply --allow-production for an authorized remote target');
  const specUrl = /\.(?:json|ya?ml)$/i.test(url.pathname) ? url.href : new URL(`${url.pathname.replace(/\/$/, '')}/openapi.json`, url.origin).href;
  const baseUrl = /\.(?:json|ya?ml)$/i.test(url.pathname) ? new URL('.', url).href.replace(/\/$/, '') : url.href.replace(/\/$/, '');
  const directory = path.resolve(options.directory ?? path.join('.gauntlet', 'projects', sha256(baseUrl).slice(0, 12)));
  await mkdir(directory, { recursive: true });
  const configPath = path.join(directory, 'gauntlet.config.json');
  const contents = await fetchContract(specUrl);
  // Validate the original downloaded bytes before promoting a new revision.
  const pending = path.join(directory, 'openapi.pending.yaml');
  await writeFile(pending, contents);
  const contract = await loadContract(pending);
  await atomicWrite(path.join(directory, 'openapi.yaml'), contents);
  const sources: string[] = [];
  const hashes: Record<string, string> = { 'openapi.yaml': sha256(contents) };
  let totalBytes = 0;
  for (const [index, source] of options.context.entries()) {
    const sourceRoot = await realpath(source);
    const rootIsFile = (await stat(sourceRoot)).isFile();
    const copy = async (file: string, relative: string): Promise<void> => {
      const resolved = await realpath(file);
      if (resolved !== sourceRoot && !resolved.startsWith(sourceRoot + path.sep)) throw new Error('ONBOARDING_CONTEXT_SYMLINK_ESCAPE');
      const info = await stat(file);
      if (info.isDirectory()) {
        for (const entry of await readdir(file, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
          await copy(path.join(file, entry.name), path.join(relative, entry.name));
        }
      } else if (info.isFile() && /\.(?:md|txt|json|jsonl|log|yaml|yml)$/i.test(file)) {
        totalBytes += info.size;
        if (info.size > 5_242_880 || totalBytes > 26_214_400 || sources.length >= 100) throw new Error('ONBOARDING_CONTEXT_LIMIT');
        const target = path.join('context', String(index), relative);
        const text = await readFile(file, 'utf8');
        await atomicWrite(path.join(directory, target), text);
        sources.push(target); hashes[target] = sha256(text);
      }
    };
    await copy(sourceRoot, rootIsFile ? path.basename(sourceRoot) : '');
  }
  // Re-onboarding preserves explicit credentials, budgets, fixtures and repair
  // configuration, but refreshes target, contract and selected context sources.
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const previousAgents = (previous.agents ?? {}) as Record<string, unknown>;
  const provider = process.env.GAUNTLET_AGENT_PROVIDER ?? (previousAgents.provider === 'azure' ? 'azure' : 'openai');
  const model = options.model ?? process.env.GAUNTLET_AGENT_MODEL ?? (provider === 'azure' ? process.env.AZURE_OPENAI_DEPLOYMENT : process.env.OPENAI_MODEL);
  if (provider === 'azure' && !model && !previousAgents.builderModel) throw new Error('AGENT_MODEL_REQUIRED: set AZURE_OPENAI_DEPLOYMENT or use --model with your Azure deployment name');
  const workflow = process.env.GAUNTLET_WORKFLOW || previous.workflow || 'tests-only';
  if (workflow !== 'tests-only' && workflow !== 'source-repair') throw new Error('CONFIG_INVALID: workflow must be tests-only or source-repair');
  const requestedSource = options.source || (workflow === 'source-repair' && !previous.sourceRepair ? process.env.GAUNTLET_API_SOURCE?.trim() : undefined);
  const sourceRepair = requestedSource ? await discoverSourceProject(baseUrl, requestedSource) : undefined;
  const fixtures = sourceRepair ? await discoverFixtures(sourceRepair,baseUrl) : undefined;
  const config = {
    projectName: contract.title, generatedDir: '.gauntlet/generated', artifactsDir: '.gauntlet/runs',
    seed: 42, maxIterations: 6, timeoutMs: 30_000, headersFromEnv: {},
    quality: { minimumScore: 95, minimumOperationCoverage: 1, minimumScenarioCoverage: 1, requireSemanticVerification: true, requireIsolationReview: true },
    ...previous, workflow, spec: 'openapi.yaml', baseUrl,
    safety: { maxRequestsPerRun: 2000, maxResponseBytes: 262144, ...(previous.safety as object ?? {}),
      allowedHosts: [url.hostname], allowedMethods: [...new Set(contract.operations.map(o => o.method))],
      allowDestructive: contract.operations.some(o => o.destructive), allowProduction: !local },
    agents: { ...(previous.agents as object ?? {}), provider, ...Object.fromEntries(['discovery', 'lead', 'builder', 'verifier', 'critic', 'healer'].map(role => [`${role}Model`, model ?? previousAgents[`${role}Model`] ?? previousAgents.builderModel ?? 'gpt-5.6-luna'])) },
    discovery: { enabled: sources.length > 0, required: sources.length > 0, sources },
    ...(sourceRepair ? { sourceRepair } : {}), ...(fixtures ? { fixtures } : {}),
  };
  await atomicWrite(configPath, stableStringify(config));
  await atomicWrite(path.join(directory, 'onboarding.json'), stableStringify({ specUrl, baseUrl, retrievedAt: new Date().toISOString(), originalContext: options.context.map(p => path.resolve(p)), hashes, operations: contract.operations.length }));
  console.error(`Onboarded ${contract.title}: ${contract.operations.length} operations, ${sources.length} context files. Config: ${configPath}`);
  return configPath;
}

export async function originalContextFiles(configPath: string): Promise<Array<{path:string;hash:string}>> {
  let manifest: {originalContext?: string[]};
  try { manifest = JSON.parse(await readFile(path.join(path.dirname(path.resolve(configPath)), 'onboarding.json'),'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const files: Array<{path:string;hash:string}> = []; let bytes = 0;
  for (const source of manifest.originalContext ?? []) {
    const root = await realpath(source);
    const visit = async (file: string): Promise<void> => {
      const resolved = await realpath(file);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('ONBOARDING_CONTEXT_SYMLINK_ESCAPE');
      const info = await stat(file);
      if (info.isDirectory()) {
        for (const entry of (await readdir(file)).sort()) if (!entry.startsWith('.') && !['node_modules','dist'].includes(entry)) await visit(path.join(file,entry));
      } else if (info.isFile() && /\.(?:md|txt|json|jsonl|log|yaml|yml)$/i.test(file)) {
        bytes += info.size;
        if (info.size > 5_242_880 || bytes > 26_214_400 || files.length >= 100) throw new Error('ONBOARDING_CONTEXT_LIMIT');
        files.push({path:`input:${resolved}`,hash:sha256(await readFile(resolved))});
      }
    };
    await visit(root);
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

export async function refreshOnboardedProject(configPath: string): Promise<void> {
  const directory = path.dirname(path.resolve(configPath));
  let manifest: {specUrl:string;originalContext:string[]};
  try {manifest=JSON.parse(await readFile(path.join(directory,'onboarding.json'),'utf8'));}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  const config=JSON.parse(await readFile(configPath,'utf8'));
  await onboard({url:manifest.specUrl,context:manifest.originalContext,directory,model:config.agents.builderModel,allowProduction:config.safety.allowProduction});
}
