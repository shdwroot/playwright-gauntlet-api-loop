import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GauntletConfig, HttpMethod } from './types.js';
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

export async function loadConfig(configPath = 'gauntlet.config.json'): Promise<{ config: GauntletConfig; configPath: string }> {
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

  const provider = agentsRaw.provider;
  if (provider !== 'deterministic' && provider !== 'openai') throw new Error('CONFIG_INVALID: agents.provider must be deterministic or openai');

  const config: GauntletConfig = {
    projectName: requireString(raw, 'projectName'),
    spec: ensureWithin(root, path.resolve(root, requireString(raw, 'spec'))),
    baseUrl: requireString(raw, 'baseUrl'),
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
      builderModel: requireString(agentsRaw, 'builderModel'),
      criticModel: requireString(agentsRaw, 'criticModel'),
      ...(typeof agentsRaw.openaiBaseUrl === 'string' ? { openaiBaseUrl: agentsRaw.openaiBaseUrl } : {}),
      ...(typeof agentsRaw.apiKeyEnv === 'string' ? { apiKeyEnv: agentsRaw.apiKeyEnv } : {}),
    },
    quality: {
      minimumScore: Math.min(100, Math.max(0, finiteNumber(qualityRaw, 'minimumScore', 95))),
      minimumOperationCoverage: Math.min(1, Math.max(0, finiteNumber(qualityRaw, 'minimumOperationCoverage', 1))),
    },
  };
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
