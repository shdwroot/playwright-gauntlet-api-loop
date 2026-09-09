import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GauntletConfig, RunResult, RunState, StateEvent } from './types.js';
import { atomicWrite, errorMessage, sha256, stableStringify } from './utils.js';

export class RunLedger {
  readonly events: StateEvent[] = [];
  readonly runDir: string;

  constructor(
    readonly runId: string,
    private readonly config: GauntletConfig,
  ) {
    this.runDir = path.join(config.artifactsDir, runId);
  }

  async initialize(specHash: string): Promise<void> {
    await mkdir(this.config.artifactsDir, { recursive: true });
    await mkdir(this.runDir, { recursive: false });
    let sourceRevision = 'uncommitted';
    try { sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no commit yet */ }
    await atomicWrite(path.join(this.runDir, 'run-manifest.json'), stableStringify({
      formatVersion: 1,
      runId: this.runId,
      projectName: this.config.projectName,
      specHash,
      configHash: sha256(stableStringify(this.config)),
      sourceRevision,
      seed: this.config.seed,
      baseUrl: new URL(this.config.baseUrl).origin,
      agentProvider: this.config.agents.provider,
      builderModel: this.config.agents.builderModel,
      criticModel: this.config.agents.criticModel,
    }));
  }

  async record(state: RunState, iteration: number, detail: string, artifact?: string): Promise<StateEvent> {
    const event: StateEvent = {
      sequence: this.events.length + 1,
      at: new Date().toISOString(),
      state,
      iteration,
      detail,
      ...(artifact ? { artifact } : {}),
    };
    this.events.push(event);
    await atomicWrite(path.join(this.runDir, 'events.json'), stableStringify(this.events));
    return event;
  }

  async write(relative: string, value: unknown): Promise<string> {
    const filePath = path.join(this.runDir, relative);
    await atomicWrite(filePath, typeof value === 'string' ? value : stableStringify(value));
    return filePath;
  }

  async finalize(result: RunResult): Promise<void> {
    await this.write('result.json', result);
  }

  static async verify(runDir: string): Promise<void> {
    try {
      const events = JSON.parse(await readFile(path.join(runDir, 'events.json'), 'utf8')) as StateEvent[];
      if (!Array.isArray(events) || events.some((event, index) => event.sequence !== index + 1)) throw new Error('invalid sequence');
    } catch (error) {
      throw new Error(`RUN_STATE_CORRUPT: ${errorMessage(error)}`);
    }
  }
}

export function newRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${timestamp}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
}
