import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from './run-agent.ts';
import type { ResearchAgentDependencies } from '../agent/agent-loop.ts';
import type { AgentResult, ResearchTask } from '../agent/types.ts';
import type { DomainResolver } from '../domain/resolver.ts';
import { buildGenericReport, writeGenericReport } from '../artifacts/generic-report.ts';
import type { EvidenceStore } from '../evidence/types.ts';
import { FileEvidenceStore } from '../evidence/file-store.ts';
import { createResearchDeadline, DEFAULT_RESEARCH_RUN_TIMEOUT_MS } from './research-deadline.ts';

export type RunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'interrupted' | 'failed' | 'cancelled';

export interface RunEvent {
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ResearchRun {
  runId: string;
  status: RunStatus;
  task: ResearchTask;
  createdAt: string;
  startedAt?: string;
  cancellationRequestedAt?: string;
  finishedAt?: string;
  settledAt?: string;
  result?: AgentResult;
  error?: { code: string; message: string };
  persistenceError?: { code: string; message: string };
  report?: { jsonPath: string; markdownPath: string; htmlPath: string };
  reportStatus: 'not_configured' | 'pending' | 'completed' | 'failed';
  reportError?: { code: string; message: string };
  events: RunEvent[];
}

export class ResearchRunManager {
  private readonly runs = new Map<string, ResearchRun>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly evidenceStores = new Map<string, EvidenceStore>();
  private readonly persistence = new Map<string, Promise<void>>();
  private readonly settling = new Set<string>();

  constructor(
    private readonly dependencies: ResearchAgentDependencies,
    private readonly maxRuns = 100,
    private readonly outputDir?: string,
    private readonly evidenceRoot?: string,
    private readonly reportWriter: typeof writeGenericReport = writeGenericReport,
    private readonly runTimeoutMs = DEFAULT_RESEARCH_RUN_TIMEOUT_MS,
    private readonly domainResolver?: DomainResolver,
  ) {}

  async hydrate(): Promise<void> {
    if (!this.outputDir) return;
    try {
      const entries = await fs.readdir(this.outputDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('run_')) continue;
        let run: ResearchRun;
        try {
          const raw = await fs.readFile(path.join(this.outputDir, entry.name, 'run.json'), 'utf8');
          run = JSON.parse(raw) as ResearchRun;
          if (run.runId !== entry.name || !Array.isArray(run.events)) continue;
        } catch { /* Ignore incomplete or unrelated artifact directories. */ }
        if (!run!) continue;
        run.reportStatus ??= run.report ? 'completed' : this.outputDir ? 'failed' : 'not_configured';
        if (run.status === 'running' || run.status === 'queued' || run.status === 'cancelling') {
          const timestamp = new Date().toISOString();
          run.status = 'failed';
          run.error = { code: 'SERVICE_RESTARTED', message: 'The service restarted before this run reached a terminal state.' };
          run.finishedAt = timestamp;
          run.settledAt = timestamp;
          run.events.push(this.createEvent(run, 'run.failed', run.error, timestamp));
          await this.persist(run);
        } else {
          run.settledAt ??= run.finishedAt;
        }
        this.runs.set(run.runId, run);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  start(task: ResearchTask): ResearchRun {
    if (this.runs.size >= this.maxRuns) this.pruneFinishedRuns();
    if (this.runs.size >= this.maxRuns) throw new Error('RUN_CAPACITY_EXCEEDED');
    const runId = `run_${randomUUID()}`;
    const run: ResearchRun = {
      runId, status: 'queued', task, createdAt: new Date().toISOString(),
      reportStatus: this.outputDir ? 'pending' : 'not_configured', events: [],
    };
    this.runs.set(runId, run);
    this.emit(run, 'run.queued', {});
    void this.execute(run);
    return this.snapshot(run);
  }

  get(runId: string): ResearchRun | undefined { const run = this.runs.get(runId); return run ? this.snapshot(run) : undefined; }
  list(): ResearchRun[] { return [...this.runs.values()].map((run) => this.snapshot(run)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  events(runId: string): RunEvent[] | undefined {
    const run = this.runs.get(runId);
    return run ? [...run.events] : undefined;
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.settledAt || this.settling.has(runId) || run.status === 'cancelling') return false;
    run.status = 'cancelling';
    run.cancellationRequestedAt = new Date().toISOString();
    this.controllers.get(runId)?.abort(new Error('Run cancelled by client'));
    this.emit(run, 'run.cancellation_requested', {});
    return true;
  }

  private async execute(run: ResearchRun): Promise<void> {
    const controller = new AbortController();
    const deadline = createResearchDeadline(this.runTimeoutMs, controller.signal);
    const evidenceStore: EvidenceStore | undefined = this.evidenceRoot ? new FileEvidenceStore(this.evidenceRoot, run.runId) : undefined;
    try {
      if (evidenceStore) this.evidenceStores.set(run.runId, evidenceStore);
      this.controllers.set(run.runId, controller);
      run.status = 'running'; run.startedAt = new Date().toISOString(); this.emit(run, 'run.started', {});
      let result: AgentResult;
      let terminalStatus: Extract<RunStatus, 'completed' | 'interrupted' | 'failed' | 'cancelled'>;
      try {
        result = await runAgent(run.task, {
          ...this.dependencies,
          evidenceStore,
          onEvent: (event) => this.emit(run, event.type, event.payload),
        }, { signal: deadline.signal, evidenceStore, ...(this.domainResolver ? { domainResolver: this.domainResolver } : {}) });
        terminalStatus = this.isCancellationRequested(run)
          ? 'cancelled'
          : result.status === 'completed' ? 'completed' : result.status === 'interrupted' ? 'interrupted' : 'failed';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.isCancellationRequested(run)) {
          terminalStatus = 'cancelled';
          result = this.failedResult(run.task, message, 'cancelled');
        } else {
          terminalStatus = 'failed';
          run.error = { code: 'RUN_FAILED', message };
          result = this.failedResult(run.task, message, 'provider_error');
        }
      }
      run.result = result;
      try {
        await evidenceStore?.flush?.();
      } catch (error) {
        this.emit(run, 'evidence.write_error', { operation: 'flush', code: 'EVIDENCE_WRITE_FAILED', message: error instanceof Error ? error.message : String(error) });
      }
      if (this.isCancellationRequested(run)) terminalStatus = 'cancelled';
      await this.writeRunReport(run, result, terminalStatus);
      if (this.isCancellationRequested(run)) terminalStatus = 'cancelled';
      await this.settleRun(run, terminalStatus, result);
    } finally {
      deadline.clear();
      this.controllers.delete(run.runId);
      this.evidenceStores.delete(run.runId);
    }
  }

  private failedResult(task: ResearchTask, message: string, reason: 'cancelled' | 'provider_error'): AgentResult {
    const decision: AgentResult['decision'] = { decision: 'review', searchActions: [], fetchActions: [], uncertainties: [message] };
    return {
      status: reason === 'cancelled' ? 'interrupted' : 'failed',
      decision,
      state: { task, currentIteration: 0, decisions: [], searchResults: [], fetchedPages: [], uncertainties: [message], interrupted: { reason, message } },
    };
  }

  private async writeRunReport(run: ResearchRun, result: AgentResult, terminalStatus: RunStatus): Promise<void> {
    if (!this.outputDir) return;
    try {
      run.report = await this.reportWriter(`${this.outputDir}/${run.runId}`, buildGenericReport(run.runId, terminalStatus, result, run.events));
      run.reportStatus = 'completed';
      delete run.reportError;
      this.emit(run, 'report.completed', run.report);
    } catch (error) {
      run.reportStatus = 'failed';
      run.reportError = { code: 'REPORT_FAILED', message: error instanceof Error ? error.message : String(error) };
      this.emit(run, 'report.failed', run.reportError);
    }
  }

  private async settleRun(
    run: ResearchRun,
    status: Extract<RunStatus, 'completed' | 'interrupted' | 'failed' | 'cancelled'>,
    result: AgentResult,
  ): Promise<void> {
    if (run.settledAt || this.settling.has(run.runId)) return;
    this.settling.add(run.runId);
    const timestamp = new Date().toISOString();
    const eventType = status === 'completed' ? 'run.completed' : status === 'interrupted' ? 'run.interrupted' : status === 'failed' ? 'run.failed' : 'run.cancelled';
    const settled: ResearchRun = {
      ...run,
      status,
      result,
      finishedAt: timestamp,
      settledAt: timestamp,
      events: [...run.events, this.createEvent(run, eventType, { status: result.status }, timestamp)],
    };
    if (status !== 'failed') delete settled.error;
    delete settled.persistenceError;
    try {
      await this.persist(settled);
    } catch (error) {
      settled.persistenceError = { code: 'RUN_PERSIST_FAILED', message: error instanceof Error ? error.message : String(error) };
    }
    Object.assign(run, settled);
    if (status !== 'failed') delete run.error;
    if (!settled.persistenceError) delete run.persistenceError;
    this.settling.delete(run.runId);
  }

  private emit(run: ResearchRun, type: string, payload: Record<string, unknown>): void {
    if (run.settledAt || this.settling.has(run.runId)) return;
    const event = this.createEvent(run, type, payload);
    run.events.push(event);
    void this.evidenceStores.get(run.runId)?.saveRunEvent?.(event).catch(() => undefined);
    void this.persist(run).catch((error) => {
      run.persistenceError = { code: 'RUN_PERSIST_FAILED', message: error instanceof Error ? error.message : String(error) };
    });
  }
  private createEvent(run: ResearchRun, type: string, payload: Record<string, unknown>, timestamp = new Date().toISOString()): RunEvent {
    return { runId: run.runId, sequence: run.events.length + 1, type, timestamp, payload };
  }
  private isCancellationRequested(run: ResearchRun): boolean { return run.status === 'cancelling'; }
  private snapshot(run: ResearchRun): ResearchRun { return { ...run, events: [...run.events] }; }
  private pruneFinishedRuns(): void { for (const [id, run] of this.runs) if (run.settledAt) this.runs.delete(id); }
  private persist(run: ResearchRun): Promise<void> {
    if (!this.outputDir) return Promise.resolve();
    const previous = this.persistence.get(run.runId) ?? Promise.resolve();
    const serialized = `${JSON.stringify(run, null, 2)}\n`;
    const next = previous.catch(() => undefined).then(async () => {
      const dir = path.join(this.outputDir!, run.runId);
      await fs.mkdir(dir, { recursive: true });
      const temp = path.join(dir, `run.json.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, serialized, 'utf8');
        await fs.rename(temp, path.join(dir, 'run.json'));
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    });
    this.persistence.set(run.runId, next);
    return next;
  }
}
