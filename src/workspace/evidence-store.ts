import { mkdir, readFile } from 'node:fs/promises';

import type { FetchedPageRecord } from '../fetch-fusion/types.js';
import { writeJsonFileAtomic } from './atomic-json.ts';
import {
  evidencePathForDocument,
  relativeEvidencePath,
  resolveEvidenceWorkspacePaths,
  type EvidenceWorkspacePaths,
} from './evidence-workspace-paths.ts';
import { buildEvidenceIdentity, normalizeTitle } from './evidence-identity.ts';

export interface EvidenceRelations {
  is_canonical: boolean;
  canonical_id: string | null;
  duplicate_of: string | null;
  duplicates: string[];
  related_to: string[];
}

export interface EvidenceDedupInfo {
  group_key: string;
  match_rule: 'normalized_url' | 'docno+title' | 'content_hash+title';
  canonical_reason: string;
  source_rank: number;
}

export interface EvidenceIndexEntry {
  document_id: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  backend: string;
  extracted_doc_no: string | null;
  evidence_path: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  dedup: EvidenceDedupInfo;
  relations: EvidenceRelations;
}

export interface EvidenceIndex {
  schema_version: 1;
  updated_at: string;
  documents: Record<string, EvidenceIndexEntry>;
}

export interface PersistedEvidenceDocument {
  schema_version: 1;
  document_id: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  task_topic: string;
  record: FetchedPageRecord;
}

function computeSourceRank(record: FetchedPageRecord): number {
  const sourceDomain = typeof record.kerry_cleaning?.metadata?.source_domain === 'string'
    ? record.kerry_cleaning.metadata.source_domain.toLowerCase()
    : '';

  if (/^(?:[a-z0-9-]+\.)*(?:gxt|kjt|fgw)\..*\.gov\.cn$/.test(sourceDomain) || /^(?:gxt|kjt|fgw)\..*\.gov\.cn$/.test(sourceDomain)) {
    return 100;
  }
  if (/\.gov\.cn$/.test(sourceDomain)) {
    return 90;
  }
  if (/news|dbw\.cn|media/i.test(sourceDomain)) {
    return 50;
  }
  return 10;
}

function defaultRelations(documentId: string): EvidenceRelations {
  return {
    is_canonical: true,
    canonical_id: documentId,
    duplicate_of: null,
    duplicates: [],
    related_to: [],
  };
}

function normalizedTitleKey(value: string): string {
  return normalizeTitle(value).replace(/[\s_\-—–|｜:：,，。.！!？?（）()\[\]【】]/g, '').trim();
}

function chooseMatchRule(candidate: EvidenceIndexEntry, existing: EvidenceIndexEntry): EvidenceDedupInfo['match_rule'] | null {
  if (candidate.finalUrl === existing.finalUrl) {
    return 'normalized_url';
  }
  if (candidate.extracted_doc_no && existing.extracted_doc_no && candidate.extracted_doc_no === existing.extracted_doc_no) {
    const left = normalizedTitleKey(candidate.title);
    const right = normalizedTitleKey(existing.title);
    if (left && right && (left === right || left.includes(right) || right.includes(left))) {
      return 'docno+title';
    }
  }
  return null;
}

function compareCanonicalPriority(left: EvidenceIndexEntry, right: EvidenceIndexEntry): number {
  if (left.dedup.source_rank !== right.dedup.source_rank) {
    return right.dedup.source_rank - left.dedup.source_rank;
  }
  if (left.first_seen_at !== right.first_seen_at) {
    return left.first_seen_at.localeCompare(right.first_seen_at);
  }
  return left.document_id.localeCompare(right.document_id);
}

function applySelfCanonical(entry: EvidenceIndexEntry): EvidenceIndexEntry {
  return {
    ...entry,
    dedup: {
      ...entry.dedup,
      canonical_reason: 'self',
    },
    relations: defaultRelations(entry.document_id),
  };
}

function applyDuplicateRelations(entries: EvidenceIndexEntry[]): EvidenceIndexEntry[] {
  if (entries.length <= 1) {
    return entries.map(applySelfCanonical);
  }

  const canonical = [...entries].sort(compareCanonicalPriority)[0];
  const duplicates = entries
    .filter((entry) => entry.document_id !== canonical.document_id)
    .map((entry) => entry.document_id)
    .sort();

  return entries.map((entry) => entry.document_id === canonical.document_id
    ? {
        ...entry,
        dedup: {
          ...entry.dedup,
          canonical_reason: entry.document_id === canonical.document_id ? (entry.document_id === canonical.document_id && duplicates.length > 0 ? 'higher_authority_source' : 'self') : entry.dedup.canonical_reason,
        },
        relations: {
          is_canonical: true,
          canonical_id: canonical.document_id,
          duplicate_of: null,
          duplicates,
          related_to: [],
        },
      }
    : {
        ...entry,
        dedup: {
          ...entry.dedup,
          canonical_reason: 'higher_authority_source',
        },
        relations: {
          is_canonical: false,
          canonical_id: canonical.document_id,
          duplicate_of: canonical.document_id,
          duplicates: [],
          related_to: [],
        },
      });
}

function rewriteRelations(index: EvidenceIndex, entry: EvidenceIndexEntry): void {
  const duplicateGroup = Object.values(index.documents).filter((existing) => chooseMatchRule(entry, existing) !== null);

  if (duplicateGroup.length <= 1) {
    index.documents[entry.document_id] = applySelfCanonical(entry);
    return;
  }

  const matchRule = duplicateGroup
    .map((existing) => chooseMatchRule(entry, existing))
    .find((rule): rule is EvidenceDedupInfo['match_rule'] => rule !== null)
    ?? entry.dedup.match_rule;

  const groupKey = matchRule === 'docno+title' && entry.extracted_doc_no
    ? `docno:${entry.extracted_doc_no}`
    : `url:${entry.finalUrl}`;

  const updatedGroup = applyDuplicateRelations(duplicateGroup.map((groupEntry) => ({
    ...groupEntry,
    dedup: {
      ...groupEntry.dedup,
      group_key: groupKey,
      match_rule: matchRule,
    },
  })));

  for (const groupEntry of updatedGroup) {
    index.documents[groupEntry.document_id] = groupEntry;
  }
}

async function readIndex(paths: EvidenceWorkspacePaths): Promise<EvidenceIndex> {
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

export async function saveEvidenceRecord(
  record: FetchedPageRecord,
  options: { workspaceRoot?: string; now?: string; taskTopic?: string } = {},
): Promise<{ documentId: string; indexEntry: EvidenceIndexEntry; evidencePath: string }> {
  const paths = resolveEvidenceWorkspacePaths(options.workspaceRoot);
  await mkdir(paths.evidenceDir, { recursive: true });
  await mkdir(paths.attachmentsDir, { recursive: true });
  await mkdir(paths.reportsDir, { recursive: true });

  const now = options.now ?? new Date().toISOString();
  const identity = buildEvidenceIdentity(record);
  const index = await readIndex(paths);
  const existing = index.documents[identity.documentId];
  const firstSeenAt = existing?.first_seen_at ?? now;
  const seenCount = (existing?.seen_count ?? 0) + 1;
  const evidencePath = evidencePathForDocument(paths, identity.documentId);

  const document: PersistedEvidenceDocument = {
    schema_version: 1,
    document_id: identity.documentId,
    first_seen_at: firstSeenAt,
    last_seen_at: now,
    seen_count: seenCount,
    task_topic: options.taskTopic ?? '',
    record,
  };

  const indexEntry: EvidenceIndexEntry = {
    document_id: identity.documentId,
    requestedUrl: record.requestedUrl,
    finalUrl: identity.normalizedFinalUrl,
    title: record.title,
    backend: record.backend,
    extracted_doc_no: identity.normalizedDocumentNumber,
    evidence_path: relativeEvidencePath(identity.documentId),
    first_seen_at: firstSeenAt,
    last_seen_at: now,
    seen_count: seenCount,
    dedup: {
      group_key: `url:${identity.normalizedFinalUrl}`,
      match_rule: 'normalized_url',
      canonical_reason: 'self',
      source_rank: computeSourceRank(record),
    },
    relations: defaultRelations(identity.documentId),
  };

  index.schema_version = 1;
  index.updated_at = now;
  index.documents[identity.documentId] = indexEntry;
  rewriteRelations(index, indexEntry);

  await writeJsonFileAtomic(evidencePath, document);
  await writeJsonFileAtomic(paths.indexPath, index);

  return {
    documentId: identity.documentId,
    indexEntry,
    evidencePath,
  };
}
