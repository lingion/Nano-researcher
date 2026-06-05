import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function buildAtomicTempPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

export async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = buildAtomicTempPath(filePath);
  let tempHandle: fs.promises.FileHandle | undefined;

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    tempHandle = await fs.promises.open(tempPath, 'w');
    await tempHandle.writeFile(contents);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    await fs.promises.rename(tempPath, filePath);

    try {
      const dirHandle = await fs.promises.open(path.dirname(filePath), 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Best-effort directory sync for interruption safety.
    }
  } catch (error) {
    if (tempHandle) {
      try {
        await tempHandle.close();
      } catch {
        // Ignore close failures; preserve original write error.
      }
    }

    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup failures; preserve original write error.
    }
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, payload: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, JSON.stringify(payload, null, 2));
}
