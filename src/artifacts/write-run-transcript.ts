import fs from 'node:fs';
import path from 'node:path';

import { safeSerializeDebugPayload } from '../runtime/sanitize-debug.js';

function buildAtomicTempPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = buildAtomicTempPath(filePath);
  let tempHandle: fs.promises.FileHandle | undefined;

  try {
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

function writeFileAtomicSync(filePath: string, contents: string): void {
  const tempPath = buildAtomicTempPath(filePath);
  let tempFd: number | undefined;

  try {
    tempFd = fs.openSync(tempPath, 'w');
    fs.writeFileSync(tempFd, contents);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    fs.renameSync(tempPath, filePath);

    try {
      const dirFd = fs.openSync(path.dirname(filePath), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Best-effort directory sync for interruption safety.
    }
  } catch (error) {
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // Ignore close failures; preserve original write error.
      }
    }

    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures; preserve original write error.
    }
    throw error;
  }
}

interface WriteRunTranscriptOptions {
  mode?: 'business' | 'debug';
}

function serializeTranscriptPayload(payload: unknown, options?: WriteRunTranscriptOptions): string {
  if (options?.mode === 'debug') {
    return JSON.stringify(JSON.parse(safeSerializeDebugPayload(payload)), null, 2);
  }
  return JSON.stringify(payload, null, 2);
}

async function writeRunTranscript(
  filePath: string,
  payload: unknown,
  options?: WriteRunTranscriptOptions,
): Promise<void> {
  await writeFileAtomic(filePath, serializeTranscriptPayload(payload, options));
}

writeRunTranscript.sync = (
  filePath: string,
  payload: unknown,
  options?: WriteRunTranscriptOptions,
): void => {
  writeFileAtomicSync(filePath, serializeTranscriptPayload(payload, options));
};

export async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
  await writeFileAtomic(filePath, contents);
}

export function writeTextFileAtomicSync(filePath: string, contents: string): void {
  writeFileAtomicSync(filePath, contents);
}

export { writeRunTranscript };
