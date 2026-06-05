import { callNanoclawModel, type EmptyResponseDiagnostics, type NanoclawRuntimeConfig } from '../src/runtime/nanoclaw-bridge.ts';

export interface LiveDiagnosticHarnessEnv {
  LIVE_AUDIT_DIAG?: string;
  LIVE_AUDIT_DIAG_MEDIUM_PROMPT?: string;
  LIVE_AUDIT_DIAG_FULL_PROMPT?: string;
}

export interface LiveDiagnosticHarnessGroupResult {
  name: 'minimal' | 'medium' | 'full';
  promptLength: number;
  ok: boolean;
  resultTextLength?: number;
  errorMessage?: string;
  diagnostics?: EmptyResponseDiagnostics;
}

export interface LiveDiagnosticHarnessResult {
  enabled: boolean;
  groups: LiveDiagnosticHarnessGroupResult[];
}

export async function runLiveDiagnosticHarness(options: {
  env?: LiveDiagnosticHarnessEnv;
  config?: NanoclawRuntimeConfig;
  callModel?: (prompt: string) => Promise<string>;
  log?: (line: string) => void;
} = {}): Promise<LiveDiagnosticHarnessResult> {
  const env = options.env ?? process.env;
  if (env.LIVE_AUDIT_DIAG !== '1') {
    return { enabled: false, groups: [] };
  }

  const mediumPrompt = env.LIVE_AUDIT_DIAG_MEDIUM_PROMPT;
  const fullPrompt = env.LIVE_AUDIT_DIAG_FULL_PROMPT;

  if (!mediumPrompt || !fullPrompt) {
    throw new Error('LIVE_AUDIT_DIAG_MEDIUM_PROMPT and LIVE_AUDIT_DIAG_FULL_PROMPT are required when LIVE_AUDIT_DIAG=1');
  }

  const log = options.log ?? console.log;
  const callModel = options.callModel ?? ((prompt: string) => callNanoclawModel(prompt, {
    config: options.config,
  }));

  const groups: Array<{ name: 'minimal' | 'medium' | 'full'; prompt: string }> = [
    { name: 'minimal', prompt: "PING: Reply 'ACK' and nothing else." },
    { name: 'medium', prompt: mediumPrompt },
    { name: 'full', prompt: fullPrompt },
  ];

  const results: LiveDiagnosticHarnessGroupResult[] = [];

  for (const group of groups) {
    try {
      const text = await callModel(group.prompt);
      log(`[GROUP ${group.name}] OK text_length=${text.length} prompt_length=${group.prompt.length}`);
      results.push({
        name: group.name,
        promptLength: group.prompt.length,
        ok: true,
        resultTextLength: text.length,
      });
    } catch (error) {
      const diagnostics = error && typeof error === 'object' && 'diagnostics' in error
        ? (error as { diagnostics?: EmptyResponseDiagnostics }).diagnostics
        : undefined;
      const message = error instanceof Error ? error.message : String(error);
      log(`[GROUP ${group.name}] FATAL ${message}`);
      results.push({
        name: group.name,
        promptLength: group.prompt.length,
        ok: false,
        errorMessage: message,
        diagnostics,
      });
    }
  }

  return {
    enabled: true,
    groups: results,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runLiveDiagnosticHarness().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
