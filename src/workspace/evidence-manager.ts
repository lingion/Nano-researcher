import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FetchedPageRecord } from '../fetch-fusion/types.js';
import {
  saveEvidenceRecord,
  type EvidenceIndex,
  type EvidenceIndexEntry,
  type PersistedEvidenceDocument,
} from './evidence-store.ts';
import { resolveEvidenceWorkspacePaths } from './evidence-workspace-paths.ts';
import { normalizeEvidenceUrl } from './evidence-identity.ts';

export interface CleanEvidenceView {
  document_id: string;
  title: string;
  finalUrl: string;
  backend: string;
  task_topic: string;
  cleaned_text: string;
  metadata?: Record<string, unknown>;
  dedup: EvidenceIndexEntry['dedup'];
  relations: EvidenceIndexEntry['relations'];
}

export class EvidenceManager {
  constructor(private readonly workspaceDir: string = path.join(process.cwd(), 'workspace')) {}

  async saveFetchResult(result: FetchedPageRecord, taskTopic: string): Promise<string> {
    const saved = await saveEvidenceRecord(result, {
      workspaceRoot: this.workspaceDir,
      taskTopic,
    });
    return saved.documentId;
  }

  async getIndex(): Promise<EvidenceIndex> {
    const paths = resolveEvidenceWorkspacePaths(this.workspaceDir);
    try {
      return JSON.parse(await readFile(paths.indexPath, 'utf8')) as EvidenceIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          schema_version: 1,
          updated_at: '',
          documents: {},
        };
      }
      throw error;
    }
  }

  async findByUrl(url: string): Promise<EvidenceIndexEntry | null> {
    const normalizedUrl = normalizeEvidenceUrl(url);
    const index = await this.getIndex();
    return Object.values(index.documents).find((entry) => normalizeEvidenceUrl(entry.finalUrl) === normalizedUrl) ?? null;
  }

  async listEvidence(): Promise<EvidenceIndexEntry[]> {
    const index = await this.getIndex();
    return Object.values(index.documents);
  }

  async getEvidence(documentId: string): Promise<CleanEvidenceView | null> {
    const index = await this.getIndex();
    const entry = index.documents[documentId];
    if (!entry) {
      return null;
    }

    const document = await this.readEvidenceDocument(entry.evidence_path);
    if (!document) {
      return null;
    }

    return {
      document_id: document.document_id,
      title: document.record.title,
      finalUrl: document.record.finalUrl,
      backend: document.record.backend,
      task_topic: document.task_topic,
      cleaned_text: document.record.content,
      metadata: document.record.kerry_cleaning?.metadata,
      dedup: entry.dedup,
      relations: entry.relations,
    };
  }

  async getCanonicalGroup(documentId: string): Promise<{ canonical: CleanEvidenceView | null; duplicates: CleanEvidenceView[] }> {
    const index = await this.getIndex();
    const entry = index.documents[documentId];
    if (!entry) {
      return { canonical: null, duplicates: [] };
    }

    const canonicalId = entry.relations.canonical_id ?? documentId;
    const canonical = await this.getEvidence(canonicalId);
    const duplicateIds = canonical?.relations.duplicates ?? [];
    const duplicates = (await Promise.all(duplicateIds.map((id) => this.getEvidence(id)))).filter((item): item is CleanEvidenceView => item !== null);

    return { canonical, duplicates };
  }

  private async readEvidenceDocument(relativeEvidencePath: string): Promise<PersistedEvidenceDocument | null> {
    try {
      const filePath = path.join(this.workspaceDir, relativeEvidencePath);
      return JSON.parse(await readFile(filePath, 'utf8')) as PersistedEvidenceDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}
