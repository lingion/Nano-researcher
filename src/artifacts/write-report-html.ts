import { writeTextFileAtomic } from '../workspace/atomic-json.ts';

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

export async function writeReportHtml(filePath: string, title: string): Promise<void> {
  const escapedTitle = escapeHtml(title);
  await writeTextFileAtomic(
    filePath,
    `<!doctype html><html><head><meta charset=\"utf-8\"><title>${escapedTitle}</title></head><body><main><h1>${escapedTitle}</h1></main></body></html>`,
  );
}
