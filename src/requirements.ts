import type { DiscoveryCandidate, DiscoverySourceSnapshot, NormalizedContract } from './types.js';
import { sha256, stableStringify } from './utils.js';
import { redactAgentText } from './agent-redaction.js';

// A criterion census is deterministic so a short model response cannot silently
// drop explicit requirements. Models still interpret, implement and verify each.
export function requirementCandidates(raw: string, source: DiscoverySourceSnapshot, contract: NormalizedContract): DiscoveryCandidate[] {
  let document: unknown;
  try { document = JSON.parse(raw); } catch { return []; }
  if (!document || typeof document !== 'object' || !Array.isArray((document as { requirements?: unknown }).requirements)) return [];
  const requirements = (document as { requirements: unknown[] }).requirements;
  const lines = raw.split(/\r?\n/);
  return requirements.flatMap(value => {
    if (!value || typeof value !== 'object') throw new Error('REQUIREMENT_INVALID');
    const r = value as Record<string, unknown>;
    if (typeof r.id !== 'string' || !Array.isArray(r.acceptance_criteria) || !r.acceptance_criteria.length) throw new Error('REQUIREMENT_INVALID: id and acceptance_criteria required');
    const endpoints = Array.isArray(r.endpoints) ? r.endpoints.filter((e): e is string => typeof e === 'string') : [];
    const operations = contract.operations.filter(o => endpoints.includes(`${o.method} ${o.path}`));
    return r.acceptance_criteria.map((criterion, index) => {
      if (typeof criterion !== 'string' || !criterion.trim()) throw new Error('REQUIREMENT_CRITERION_INVALID');
      const id = Array.isArray(r.criterion_ids) && typeof r.criterion_ids[index] === 'string' ? r.criterion_ids[index] : `${r.id}-AC${index + 1}`;
      const encoded = JSON.stringify(criterion);
      const line = lines.findIndex(text => text.includes(encoded)) + 1;
      return {
        id: `requirement-${id}-${sha256(stableStringify({ criterion, endpoints, track: r.track })).slice(0, 12)}`,
        title: `${id}: ${String(r.title ?? '')}`, origin: 'requirement' as const, signal: 'semantic-scenario' as const,
        confidence: 1, disposition: 'report-only' as const,
        rationale: 'Explicit supplied acceptance criterion; implementation and fresh evidence are required.',
        reason: operations.length ? 'Unimplemented explicit requirement.' : 'Requirement references routes absent from the supplied contract.',
        scenario: { requirementId: r.id, criterionId: id, track: r.track, expectedBehavior: redactAgentText(criterion), endpoints, setup: r.setup, sourceFiles: r.source_files },
        ...(operations[0] ? { operationId: operations[0].operationId } : {}), operationIds: operations.map(o => o.operationId),
        contractPointers: operations.map(o => o.sourcePointer),
        evidence: [{ sourceId: source.id, sourcePath: source.sourcePath, sourceHash: source.sourceHash,
          lineStart: line || 1, lineEnd: line || lines.length, excerpt: redactAgentText(criterion) }],
      };
    });
  });
}
