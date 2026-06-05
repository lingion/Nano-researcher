import { writeFile } from 'node:fs/promises';

export async function writeResultAudit(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(payload, null, 2));
}
