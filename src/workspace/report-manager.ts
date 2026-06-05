import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { writeTextFileAtomic } from './atomic-json.ts';
import { resolveEvidenceWorkspacePaths } from './evidence-workspace-paths.ts';

function sanitizeReportSlug(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'report';
}

function buildReportId(input: { title: string; taskTopic: string; canonicalDocumentIds: string[] }): string {
  const source = JSON.stringify(input);
  return `rpt_${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
}

function renderFrontMatter(input: {
  reportId: string;
  title: string;
  taskTopic: string;
  canonicalDocumentIds: string[];
  duplicateDocumentIds: string[];
  createdAt: string;
}): string {
  const canonicalLines = input.canonicalDocumentIds.map((id) => `  - ${id}`).join('\n');
  const duplicateLines = input.duplicateDocumentIds.map((id) => `  - ${id}`).join('\n');

  return [
    '---',
    `report_id: ${input.reportId}`,
    `title: ${input.title}`,
    `task_topic: ${input.taskTopic}`,
    'canonical_document_ids:',
    canonicalLines || '  []',
    'duplicate_document_ids:',
    duplicateLines || '  []',
    `created_at: ${input.createdAt}`,
    '---',
    '',
  ].join('\n');
}

export class ReportManager {
  constructor(private readonly workspaceDir: string = path.join(process.cwd(), 'workspace')) {}

  async writeReport(input: {
    title: string;
    taskTopic: string;
    canonicalDocumentIds: string[];
    duplicateDocumentIds?: string[];
    content: string;
  }): Promise<{ reportId: string; path: string }> {
    const paths = resolveEvidenceWorkspacePaths(this.workspaceDir);
    await mkdir(paths.reportsDir, { recursive: true });

    const reportId = buildReportId({
      title: input.title,
      taskTopic: input.taskTopic,
      canonicalDocumentIds: input.canonicalDocumentIds,
    });
    const createdAt = new Date().toISOString();
    const slug = sanitizeReportSlug(input.title);
    const relativePath = path.posix.join('reports', `${slug}.md`);
    const filePath = path.join(paths.reportsDir, `${slug}.md`);
    const markdown = `${renderFrontMatter({
      reportId,
      title: input.title,
      taskTopic: input.taskTopic,
      canonicalDocumentIds: input.canonicalDocumentIds,
      duplicateDocumentIds: input.duplicateDocumentIds ?? [],
      createdAt,
    })}${input.content.trim()}\n`;

    await writeTextFileAtomic(filePath, markdown);

    return {
      reportId,
      path: relativePath,
    };
  }
}
