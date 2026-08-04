import fs from 'node:fs/promises';
import path from 'node:path';
import type { FetchResponse, SearchResult } from '../agent/types.ts';
import type { RunEvent } from '../app/run-manager.ts';
import type { EvidenceStore } from './types.ts';

export class FileEvidenceStore implements EvidenceStore {
  private pending = Promise.resolve();
  constructor(private readonly root: string, private readonly runId: string) {}

  private async ensure(): Promise<void> { await fs.mkdir(path.join(this.root, this.runId), { recursive: true }); }
  private append(name: string, value: unknown): Promise<void> {
    this.pending = this.pending.then(async () => {
      await this.ensure();
      await fs.appendFile(path.join(this.root, this.runId, name), `${JSON.stringify(value)}\n`, 'utf8');
    });
    return this.pending;
  }

  async saveRunEvent(event: RunEvent): Promise<void> { await this.append('events.jsonl', event); }
  async saveSearchResults(results: SearchResult[]): Promise<void> { await this.append('search-results.jsonl', results); }
  async saveFetchedPage(page: FetchResponse): Promise<void> { await this.append('fetched-pages.jsonl', page); }
  async saveAgentResult(result: unknown): Promise<void> {
    this.pending = this.pending.then(async () => {
      await this.ensure();
      await fs.writeFile(path.join(this.root, this.runId, 'agent-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    });
    await this.pending;
  }
  async flush(): Promise<void> { await this.pending; }
}
