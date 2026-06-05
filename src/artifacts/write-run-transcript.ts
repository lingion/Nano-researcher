import fs from 'node:fs';
import path from 'node:path';

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

async function writeRunTranscript(filePath: string, payload: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(payload, null, 2));
}

writeRunTranscript.sync = (filePath: string, payload: unknown): void => {
  writeFileAtomicSync(filePath, JSON.stringify(payload, null, 2));
};

export { writeRunTranscript };
