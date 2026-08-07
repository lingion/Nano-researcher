import 'dotenv/config';

import { createResearchHttpServer } from './server.ts';
import { createGenericDomainResolver, createGenericFetchProvider, createGenericLlmProvider, createGenericSearchProvider } from '../../app/create-generic-dependencies.ts';
import { ResearchRunManager } from '../../app/run-manager.ts';
import { assertSafeHttpExposure } from './exposure.ts';
import { parseResearchRunTimeoutMs } from '../../app/research-deadline.ts';

const port = Number(process.env.RESEARCH_HTTP_PORT ?? 8787);
const host = process.env.RESEARCH_HTTP_HOST ?? '127.0.0.1';
const authToken = process.env.RESEARCH_HTTP_AUTH_TOKEN;
assertSafeHttpExposure(host, authToken);
const fetchProvider = createGenericFetchProvider();
const dependencies = { llm: createGenericLlmProvider(), search: createGenericSearchProvider(), fetch: fetchProvider };
const outputDir = process.env.RESEARCH_OUTPUT_DIR ?? './artifacts/runs';
const domainResolver = createGenericDomainResolver();
const manager = new ResearchRunManager(dependencies, 100, outputDir, process.env.RESEARCH_EVIDENCE_DIR ?? `${outputDir}/evidence`, undefined, parseResearchRunTimeoutMs(), domainResolver);
await manager.hydrate();
const server = createResearchHttpServer(dependencies, manager, { exposeAtomicTools: process.env.RESEARCH_EXPOSE_ATOMIC_TOOLS === '1', authToken, reportRoot: outputDir, domainResolver });
server.on('close', () => { void fetchProvider.close?.(); });
server.listen(port, host, () => console.error(`generic research HTTP server listening on ${host}:${port}`));
