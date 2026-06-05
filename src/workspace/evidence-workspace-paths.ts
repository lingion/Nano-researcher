import path from 'node:path';

export interface EvidenceWorkspacePaths {
  rootDir: string;
  indexPath: string;
  evidenceDir: string;
  attachmentsDir: string;
  reportsDir: string;
}

export function resolveEvidenceWorkspacePaths(rootDir = path.join(process.cwd(), 'workspace')): EvidenceWorkspacePaths {
  return {
    rootDir,
    indexPath: path.join(rootDir, 'index.json'),
    evidenceDir: path.join(rootDir, 'evidence'),
    attachmentsDir: path.join(rootDir, 'attachments'),
    reportsDir: path.join(rootDir, 'reports'),
  };
}

export function evidencePathForDocument(paths: EvidenceWorkspacePaths, documentId: string): string {
  return path.join(paths.evidenceDir, `${documentId}.json`);
}

export function relativeEvidencePath(documentId: string): string {
  return path.posix.join('evidence', `${documentId}.json`);
}
