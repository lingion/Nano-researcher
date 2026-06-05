import { createHash } from 'node:crypto';

import type { FetchedPageRecord } from '../fetch-fusion/types.js';
import { normalizeDocumentNumber } from '../fetch-fusion/local-fetch-primary.ts';

export function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeEvidenceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

export function buildEvidenceIdentity(record: FetchedPageRecord): {
  documentId: string;
  normalizedFinalUrl: string;
  normalizedDocumentNumber: string | null;
  normalizedTitle: string;
} {
  const normalizedFinalUrl = normalizeEvidenceUrl(record.finalUrl || record.requestedUrl);
  const normalizedDocumentNumber = normalizeDocumentNumber(record.evidence_clues?.extracted_doc_no ?? null);
  const normalizedTitle = normalizeTitle(record.title);
  const identity = JSON.stringify({
    finalUrl: normalizedFinalUrl,
    documentNumber: normalizedDocumentNumber,
    title: normalizedTitle,
  });
  const shortHash = createHash('sha256').update(identity).digest('hex').slice(0, 12);

  return {
    documentId: `doc_${shortHash}`,
    normalizedFinalUrl,
    normalizedDocumentNumber,
    normalizedTitle,
  };
}
