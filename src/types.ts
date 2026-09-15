export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  nullable?: boolean;
  [key: string]: unknown;
}

export interface NormalizedParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: JsonSchema;
  example?: unknown;
  sourcePointer: string;
}

export interface NormalizedResponse {
  authority?: 'openapi' | 'requirement';
  status: number;
  contentType?: string;
  schema?: JsonSchema;
  sourcePointer: string;
}

export interface NormalizedOperation {
  authority?: 'openapi' | 'requirement';
  operationId: string;
  method: HttpMethod;
  path: string;
  sourcePointer: string;
  summary: string;
  parameters: NormalizedParameter[];
  requestBody?: {
    required: boolean;
    contentType: string;
    schema: JsonSchema;
    sourcePointer: string;
  };
  responses: NormalizedResponse[];
  secured: boolean;
  skipStandalone: boolean;
  destructive: boolean;
}

export interface WorkflowDefinition {
  id: string;
  title: string;
  steps: Array<{
    operationId: string;
    capture?: Record<string, string>;
    pathParams?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }>;
}

export interface NormalizedContract {
  title: string;
  version: string;
  specPath: string;
  specHash: string;
  document: Record<string, unknown>;
  operations: NormalizedOperation[];
  workflows: WorkflowDefinition[];
  warnings: string[];
}

export type CaseKind = 'positive' | 'boundary' | 'validation' | 'authorization' | 'not-found' | 'conflict' | 'discovered';

export type DiscoverySourceKind = 'auto' | 'log' | 'document';
export type DiscoverySignal =
  | 'malformed-json'
  | 'unsupported-media-type'
  | 'query-boundary'
  | 'whitespace-validation'
  | 'missing-auth'
  | 'not-found'
  | 'conflict'
  | 'oversized-payload'
  | 'contract-violation'
  | 'unclassified'
  | 'semantic-scenario';
export type DiscoveryDisposition = 'generate' | 'merge' | 'report-only' | 'reject';

export interface DiscoverySourceConfig {
  id: string;
  path: string;
  kind: DiscoverySourceKind;
}

export interface DiscoveryConfig {
  enabled: boolean;
  required: boolean;
  sources: DiscoverySourceConfig[];
  allowedExtensions: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCandidates: number;
  maxCandidatesPerOperation: number;
  maxExcerptCharacters: number;
  minimumConfidence: number;
  maxAgentInputCharacters?: number;
}

export interface DiscoveryEvidence {
  sourceId: string;
  sourcePath: string;
  sourceHash: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
}

export interface DiscoveryCandidate {
  id: string;
  signal: DiscoverySignal;
  title?: string;
  rationale?: string;
  scenario?: unknown;
  origin?: 'llm' | 'deterministic' | 'requirement';
  operationIds?: string[];
  method?: HttpMethod;
  observedPath?: string;
  observedStatus?: number;
  operationId?: string;
  confidence: number;
  disposition: DiscoveryDisposition;
  reason: string;
  contractPointers: string[];
  evidence: DiscoveryEvidence[];
}

export interface DiscoverySourceSnapshot {
  id: string;
  configuredPath: string;
  sourcePath: string;
  sourceHash: string;
  bytes: number;
  kind: Exclude<DiscoverySourceKind, 'auto'>;
  parserVersion: string;
  status: 'parsed' | 'warning' | 'rejected';
  findings: string[];
}

export interface DiscoveryReport {
  formatVersion: 1;
  specHash: string;
  discoveryHash: string;
  sourceCount: number;
  totalBytes: number;
  sources: DiscoverySourceSnapshot[];
  candidates: DiscoveryCandidate[];
  warnings: string[];
  redactionCount: number;
  analysis?: { mode: 'llm' | 'deterministic' | 'disabled'; invocations: AgentInvocation[] };
}

export interface ExpectedResponse {
  statuses: number[];
  variants?: Array<{ status: number; contentType?: string; schema?: JsonSchema }>;
  contentType?: string;
  schema?: JsonSchema;
}

export interface ResponseAssertion {
  whenStatuses?: number[];
  target?: 'body' | 'headers' | 'fixture' | 'parallel';
  path: string;
  operator: 'equals' | 'not-equals' | 'length-equals' | 'length-lte' | 'length-gte' | 'contains' | 'gte' | 'lte' | 'exists' | 'not-exists';
  value: unknown;
  sourcePointer: string;
}

export interface TestCasePlan {
  oracleOrigin?: 'agent';
  authoredBy?: 'agent';
  assertions?: ResponseAssertion[];
  id: string;
  title: string;
  kind: CaseKind;
  operationId: string;
  sourcePointer: string;
  method: HttpMethod;
  path: string;
  pathParams: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  bodyEncoding?: 'json' | 'form';
  useAuth: boolean;
  destructive: boolean;
  expected: ExpectedResponse;
  rationale: string;
  discovery?: {
    signal: DiscoverySignal;
    candidateIds: string[];
    evidence: DiscoveryEvidence[];
    linkRationale?: string;
  };
  oracleProvenance: Array<{
    authority: 'openapi' | 'requirement';
    specHash: string;
    sourcePointer: string;
  }>;
}

export interface WorkflowStepPlan extends TestCasePlan {
  capture: Record<string, string>;
  parallelGroup?: string;
}

export interface WorkflowPlan {
  id: string;
  title: string;
  steps: WorkflowStepPlan[];
  cleanupSteps?: WorkflowStepPlan[];
}

export interface TestPlan {
  fixtureAuthentication?: boolean;
  isolation?: { beforeEach: WorkflowStepPlan[]; afterEach: WorkflowStepPlan[] };
  formatVersion: 1;
  projectName: string;
  specPath: string;
  specHash: string;
  seed: number;
  operations: Array<{
    operationId: string;
    sourcePointer: string;
    coveredBy: string[];
    blockedReason?: string;
  }>;
  cases: TestCasePlan[];
  workflows: WorkflowPlan[];
  warnings: string[];
  discovery?: DiscoveryReport;
}

export interface AgentInvocation {
  agentId: string;
  model: string;
  output: unknown;
  promptHash: string;
  responseHash: string;
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentConfig {
  provider: 'deterministic' | 'openai' | 'azure';
  builderModel: string;
  criticModel: string;
  discoveryModel?: string;
  leadModel?: string;
  healerModel?: string;
  verifierModel?: string;
  timeoutMs?: number;
  openaiBaseUrl?: string;
  azureEndpoint?: string;
  apiKeyEnv?: string;
}

export interface GauntletConfig {
  fixtures?: { adapter: 'dvra'; command: string[]; apiOrigin?: string };
  sourceRepair?: {
    root: string;
    include: string[];
    verifyCommand: string[];
    restartCommand: string[];
    maxAttempts: number;
    commandTimeoutMs: number;
  };
  isolation?: { operationId: string; request: Record<string, unknown> };
  projectRoot: string;
  projectName: string;
  spec: string;
  baseUrl: string;
  generatedDir: string;
  artifactsDir: string;
  seed: number;
  maxIterations: number;
  timeoutMs: number;
  headersFromEnv: Record<string, string>;
  safety: {
    allowedHosts: string[];
    allowedMethods: HttpMethod[];
    allowDestructive: boolean;
    allowProduction: boolean;
    maxRequestsPerRun: number;
    maxResponseBytes: number;
  };
  agents: AgentConfig;
  quality: {
    minimumScore: number;
    minimumOperationCoverage: number;
    minimumScenarioCoverage?: number;
    requireSemanticVerification?: boolean;
    requireIsolationReview?: boolean;
  };
  discovery: DiscoveryConfig;
}

export interface GeneratedManifest {
  formatVersion: 1;
  rendererVersion: string;
  projectName: string;
  specPath: string;
  specHash: string;
  seed: number;
  planHash: string;
  caseCount: number;
  workflowCount: number;
  operationCount: number;
  discoveryHash?: string;
  files: Record<string, string>;
}

export type RunState =
  | 'DISCOVER'
  | 'PLAN'
  | 'GENERATE'
  | 'EXECUTE'
  | 'CRITIQUE'
  | 'HEAL'
  | 'PASSED'
  | 'FAILED'
  | 'BLOCKED'
  | 'STALLED';

export interface StateEvent {
  sequence: number;
  at: string;
  state: RunState;
  iteration: number;
  detail: string;
  artifact?: string;
}

export interface ExecutionSummary {
  exitCode: number;
  status: 'passed' | 'test-failed' | 'infrastructure-failed' | 'framework-failed';
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  reportPath: string;
  stdoutPath: string;
  stderrPath: string;
  failureFingerprints: string[];
  failures?: Array<{ title: string; messages: string[]; exchanges: unknown[] }>;
  observations?: Array<{ title: string; status: string; startedAt?: string; exchanges: unknown[] }>;
  observationsOmitted?: number;
}

export interface CriticFinding {
  code: string;
  severity: 'blocking' | 'warning' | 'info';
  message: string;
  evidence: string[];
  repair?: 'regenerate-data' | 'regenerate-artifacts' | 'none';
}

export interface CriticVerdict {
  decision: 'pass' | 'fix' | 'block';
  score: number;
  hardFailures: string[];
  findings: CriticFinding[];
  criticId: string;
  evidenceHash: string;
  invocation?: AgentInvocation;
}

export interface HealAudit {
  iteration: number;
  classification: string;
  policyDecision: 'auto' | 'denied' | 'approval-required';
  hypothesis: string;
  changedFiles: string[];
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
  diffPath?: string;
  rollback: boolean;
}

export interface RunResult {
  coverage?: import('./coverage.js').CoverageBacklog;
  runId: string;
  status: 'PASSED' | 'FAILED' | 'BLOCKED' | 'STALLED';
  iterations: number;
  runDir: string;
  finalScore: number;
  findings: CriticFinding[];
  events: StateEvent[];
  heals: HealAudit[];
}
