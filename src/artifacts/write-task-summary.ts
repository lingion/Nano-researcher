import { writeJsonFileAtomic } from '../workspace/atomic-json.ts';

export async function writeTaskSummary(filePath: string, payload: unknown): Promise<void> {
  await writeJsonFileAtomic(filePath, payload);
}
