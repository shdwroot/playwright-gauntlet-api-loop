import type { DiscoveryReport, HttpMethod, NormalizedContract, NormalizedOperation } from './types.js';
import { sha256, stableStringify } from './utils.js';

// Supplemental expectations come from explicit supplied criteria, never from
// observed failures. Existing OpenAPI statuses/schemas are never overwritten.
export function explicitStatuses(criterion: string): number[] {
  const statuses = new Set<number>();
  const groups = criterion.matchAll(/\b(?:returns?|receiv(?:e|es)|fails? with|forbidden with|responds? with)\s+((?:[1-5]\d{2})(?:\s*(?:,|or|and|\/)\s*[1-5]\d{2})*)/gi);
  for (const group of groups) for (const code of group[1]!.match(/\b[1-5]\d{2}\b/g) ?? []) statuses.add(Number(code));
  for (const family of criterion.matchAll(/\b([45])xx\b/gi)) for (let n = Number(family[1]) * 100; n < Number(family[1]) * 100 + 100; n++) statuses.add(n);
  return [...statuses].sort((a,b) => a-b);
}

export function addRequirementOracles(original: NormalizedContract, discovery: DiscoveryReport): NormalizedContract {
  const contract = structuredClone(original);
  const extension: Record<string, unknown> = {};
  for (const candidate of discovery.candidates.filter(c => c.origin === 'requirement')) {
    const scenario = candidate.scenario as { expectedBehavior?: string; endpoints?: string[] } | undefined;
    if (!scenario || typeof scenario.expectedBehavior !== 'string' || !Array.isArray(scenario.endpoints)) continue;
    const statuses = explicitStatuses(scenario.expectedBehavior);
    const mapped: NormalizedOperation[] = [];
    for (const endpoint of scenario.endpoints) {
      const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/[^\s?#]*)$/.exec(endpoint);
      if (!match || match[2]!.startsWith('//')) continue;
      const method = match[1] as HttpMethod; const route = match[2]!;
      let operation = contract.operations.find(o => o.method === method && o.path === route);
      const syntheticId = `requirement-${method.toLowerCase()}-${sha256(route).slice(0,12)}`;
      if (!operation) {
        operation = { operationId: syntheticId, method, path: route, authority: 'requirement',
          sourcePointer: `/x-gauntlet-requirement-oracles/${syntheticId}`, summary: endpoint,
          parameters: [...route.matchAll(/\{([^}]+)\}/g)].map(m => ({ name: m[1]!, in: 'path' as const, required: true, schema: { type: 'string' }, sourcePointer: `/x-gauntlet-requirement-oracles/${syntheticId}` })),
          responses: [], secured: false, skipStandalone: false, destructive: ['POST','PUT','PATCH','DELETE'].includes(method) };
        contract.operations.push(operation);
      }
      mapped.push(operation);
      const key = operation.operationId;
      const entry = (extension[key] ??= { method, path: route, criteria: [], responses: {} }) as { criteria: unknown[]; responses: Record<string, unknown> };
      entry.criteria.push({ id: candidate.id, expectedBehavior: scenario.expectedBehavior, evidence: candidate.evidence });
      for (const status of statuses) {
        if (operation.responses.some(r => r.status === status)) continue;
        // Evidence is already stored once in criteria; a 4xx family must not
        // repeat the entire paragraph and citation in one hundred responses.
        entry.responses[String(status)] = { criterionId: candidate.id };
        operation.responses.push({ status, authority: 'requirement', sourcePointer: `/x-gauntlet-requirement-oracles/${key}/responses/${status}` });
      }
    }
    candidate.operationIds = mapped.map(o => o.operationId);
    if (mapped[0]) candidate.operationId = mapped[0].operationId;
    candidate.contractPointers = mapped.map(o => o.sourcePointer);
    if (mapped.length) candidate.reason = 'Explicit requirement mapped to the effective contract; execution and semantic proof remain required.';
  }
  if (Object.keys(extension).length) contract.document['x-gauntlet-requirement-oracles'] = extension;
  const { discoveryHash: _hash, ...unsigned } = discovery;
  discovery.discoveryHash = sha256(stableStringify(unsigned));
  return contract;
}

export function validOraclePointer(contract: NormalizedContract, authority: string, pointer: string): boolean {
  return contract.operations.some(o => (o.sourcePointer === pointer && (o.authority ?? 'openapi') === authority)
    || o.responses.some(r => r.sourcePointer === pointer && (r.authority ?? 'openapi') === authority));
}
