import { writeFile } from 'node:fs/promises';

export async function writeReportHtml(filePath: string, title: string): Promise<void> {
  await writeFile(
    filePath,
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`,
  );
}
