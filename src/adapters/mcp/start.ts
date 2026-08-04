import 'dotenv/config';
import { startGenericMcpServer } from './server.ts';

startGenericMcpServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
