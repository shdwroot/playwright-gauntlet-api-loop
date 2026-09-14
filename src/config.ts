import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import type { DiscoverySourceConfig, GauntletConfig, HttpMethod } from './types.js';
import { ensureWithin } from './utils.js';

const HTTP_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`CONFIG_INVALID: ${key} must be a non-empty string`);
  return value;
}

function requireRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`CONFIG_INVALID: ${key} must be an object`);
  return value as Record<string, unknown>;
}

function finiteNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`CONFIG_INVALID: ${key} must be a finite number`);
  return value;
}

function positiveInteger(record: Record<string, unknown>, key: string, fallback: number): number {
  return Math.max(1, Math.floor(finiteNumber(record, key, fallback)));
}

function discoveryConfig(raw: Record<string, unknown>, root: string): GauntletConfig['discovery'] {
  const value = raw.discovery;
  if (value === undefined) {
    return {
      enabled: false, required: false, sources: [],
      allowedExtensions: ['.json', '.jsonl', '.log', '.md', '.txt', '.yaml', '.yml'],
      maxFiles: 100, maxFileBytes: 5_242_880, maxTotalBytes: 26_214_400,
      maxCandidates: 5_000, maxCandidatesPerOperation: 20,
      maxExcerptCharacters: 512, minimumConfidence: 0.85,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONFIG_INVALID: discovery must be an object');
  const record = value as Record<string, unknown>;
  const sourcesRaw = record.sources ?? [];
  if (!Array.isArray(sourcesRaw)) throw new Error('CONFIG_INVALID: discovery.sources must be an array');
  const sources: DiscoverySourceConfig[] = sourcesRaw.map((entry, index) => {
    if (typeof entry === 'string') {
      return { id: `source-${index + 1}`, path: ensureWithin(root, path.resolve(root, entry)), kind: 'auto' };
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`CONFIG_INVALID: discovery.sources[${index}] must be a string or object`);
    const source = entry as Record<string, unknown>;
    const sourcePath = requireString(source, 'path');
    const kind = source.kind ?? 'auto';
    if (kind !== 'auto' && kind !== 'log' && kind !== 'document') throw new Error(`CONFIG_INVALID: discovery.sources[${index}].kind must be auto, log, or document`);
    return {
      id: typeof source.id === 'string' && source.id.trim() ? source.id : `source-${index + 1}`,
      path: ensureWithin(root, path.resolve(root, sourcePath)),
      kind,
    };
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('CONFIG_INVALID: discovery source ids must be unique');
  const extensionRaw = record.allowedExtensions ?? ['.json', '.jsonl', '.log', '.md', '.txt', '.yaml', '.yml'];
  if (!Array.isArray(extensionRaw) || extensionRaw.some((entry) => typeof entry !== 'string')) throw new Error('CONFIG_INVALID: discovery.allowedExtensions must be strings');
  const minimumConfidence = finiteNumber(record, 'minimumConfidence', 0.85);
  if (minimumConfidence < 0 || minimumConfidence > 1) throw new Error('CONFIG_INVALID: discovery.minimumConfidence must be between 0 and 1');
  return {
    enabled: Boolean(record.enabled ?? sources.length > 0),
    required: Boolean(record.required),
    sources,
    allowedExtensions: (extensionRaw as string[]).map((entry) => entry.startsWith('.') ? entry.toLowerCase() : `.${entry.toLowerCase()}`),
    maxFiles: positiveInteger(record, 'maxFiles', 100),
    maxFileBytes: positiveInteger(record, 'maxFileBytes', 5_242_880),
    maxTotalBytes: positiveInteger(record, 'maxTotalBytes', 26_214_400),
    maxCandidates: positiveInteger(record, 'maxCandidates', 5_000),
    maxCandidatesPerOperation: positiveInteger(record, 'maxCandidatesPerOperation', 20),
    maxExcerptCharacters: positiveInteger(record, 'maxExcerptCharacters', 512),
    minimumConfidence,
    maxAgentInputCharacters: positiveInteger(record, 'maxAgentInputCharacters', 200_000),
  };
}

export function loadProjectEnvironment(configPath = 'gauntlet.config.json'): void {
  const envPath = path.join(path.dirname(path.resolve(configPath)), '.env');
  try { loadEnvFile(envPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function loadConfig(configPath = 'gauntlet.config.json'): Promise<{ config: GauntletConfig; configPath: string }> {
  loadProjectEnvironment(configPath);
  const absoluteConfig = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absoluteConfig, 'utf8')) as Record<string, unknown>;
  const root = path.dirname(absoluteConfig);
  const safetyRaw = requireRecord(raw, 'safety');
  const agentsRaw = requireRecord(raw, 'agents');
  const qualityRaw = requireRecord(raw, 'quality');

  const methodsRaw = safetyRaw.allowedMethods;
  if (!Array.isArray(methodsRaw) || methodsRaw.length === 0) throw new Error('CONFIG_INVALID: safety.allowedMethods must not be empty');
  const allowedMethods = methodsRaw.map((method) => String(method).toUpperCase()).filter((method): method is HttpMethod => HTTP_METHODS.has(method as HttpMethod));
  if (allowedMethods.length !== methodsRaw.length) throw new Error('CONFIG_INVALID: safety.allowedMethods contains an unsupported method');

  const hostsRaw = safetyRaw.allowedHosts;
  if (!Array.isArray(hostsRaw) || hostsRaw.some((host) => typeof host !== 'string')) throw new Error('CONFIG_INVALID: safety.allowedHosts must be strings');
  const headersRaw = (raw.headersFromEnv ?? {}) as Record<string, unknown>;
  if (!headersRaw || typeof headersRaw !== 'object' || Array.isArray(headersRaw)) throw new Error('CONFIG_INVALID: headersFromEnv must be an object');

  const provider = process.env.GAUNTLET_AGENT_PROVIDER ?? agentsRaw.provider;
  const modelOverride = process.env.GAUNTLET_AGENT_MODEL;
  const model = (key: string, fallback?: string): string => modelOverride || (agentsRaw[key] === undefined && fallback ? fallback : requireString(agentsRaw, key));
  if (provider !== 'deterministic' && provider !== 'openai') throw new Error('CONFIG_INVALID: agents.provider must be deterministic or openai');

  const config: GauntletConfig = {
    ...(raw.isolation ? { isolation: (() => {
      const isolation = requireRecord(raw, 'isolation');
      return { operationId: requireString(isolation, 'operationId'), request: requireRecord(isolation, 'request') };
    })() } : {}),
    projectRoot: root,
    projectName: requireString(raw, 'projectName'),
    spec: ensureWithin(root, path.resolve(root, requireString(raw, 'spec'))),
    baseUrl: process.env.GAUNTLET_BASE_URL?.trim() || requireString(raw, 'baseUrl'),
    generatedDir: ensureWithin(root, path.resolve(root, requireString(raw, 'generatedDir'))),
    artifactsDir: ensureWithin(root, path.resolve(root, requireString(raw, 'artifactsDir'))),
    seed: finiteNumber(raw, 'seed', 42),
    maxIterations: Math.max(1, Math.floor(finiteNumber(raw, 'maxIterations', 3))),
    timeoutMs: Math.max(1_000, Math.floor(finiteNumber(raw, 'timeoutMs', 30_000))),
    headersFromEnv: Object.fromEntries(Object.entries(headersRaw).map(([header, envName]) => {
      if (typeof envName !== 'string' || envName.trim() === '') throw new Error(`CONFIG_INVALID: environment variable for ${header} is invalid`);
      return [header.toLowerCase(), envName];
    })),
    safety: {
      allowedHosts: hostsRaw as string[],
      allowedMethods,
      allowDestructive: Boolean(safetyRaw.allowDestructive),
      allowProduction: Boolean(safetyRaw.allowProduction),
      maxRequestsPerRun: Math.max(1, Math.floor(finiteNumber(safetyRaw, 'maxRequestsPerRun', 100))),
      maxResponseBytes: Math.max(1_024, Math.floor(finiteNumber(safetyRaw, 'maxResponseBytes', 65_536))),
    },
    agents: {
      provider,
      builderModel: model('builderModel'),
      criticModel: model('criticModel'),
      discoveryModel: model('discoveryModel', model('builderModel')),
      leadModel: model('leadModel', model('builderModel')),
      healerModel: model('healerModel', model('builderModel')),
      verifierModel: model('verifierModel', model('criticModel')),
      timeoutMs: positiveInteger(agentsRaw, 'timeoutMs', 120_000),
      ...(typeof agentsRaw.openaiBaseUrl === 'string' ? { openaiBaseUrl: agentsRaw.openaiBaseUrl } : {}),
      ...(typeof agentsRaw.apiKeyEnv === 'string' ? { apiKeyEnv: agentsRaw.apiKeyEnv } : {}),
    },
    quality: {
      minimumScore: Math.min(100, Math.max(0, finiteNumber(qualityRaw, 'minimumScore', 95))),
      minimumOperationCoverage: Math.min(1, Math.max(0, finiteNumber(qualityRaw, 'minimumOperationCoverage', 1))),
      minimumScenarioCoverage: Math.min(1, Math.max(0, finiteNumber(qualityRaw, 'minimumScenarioCoverage', provider === 'openai' ? 1 : 0))),
      requireSemanticVerification: qualityRaw.requireSemanticVerification !== false && provider === 'openai',
      requireIsolationReview: qualityRaw.requireIsolationReview !== false && provider === 'openai',
    },
    discovery: discoveryConfig(raw, root),
  };
  if (config.discovery.enabled && config.discovery.sources.length === 0 && config.discovery.required) {
    throw new Error('NO_DISCOVERY_SOURCES_CONFIGURED');
  }
  validateTarget(config);
  return { config, configPath: absoluteConfig };
}

export function validateTarget(config: GauntletConfig): void {
  const target = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('TARGET_DENIED: only HTTP(S) targets are supported');
  if (!config.safety.allowedHosts.includes(target.hostname)) throw new Error(`TARGET_DENIED: ${target.hostname} is not allowlisted`);
  const loopback = target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '::1';
  if (!loopback && !config.safety.allowProduction) throw new Error('TARGET_DENIED: non-loopback targets require safety.allowProduction=true');
}
