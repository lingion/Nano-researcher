import { safeSerializeDebugPayload } from './sanitize-debug.js';

function formatExtra(extra: unknown): string {
  return extra === undefined ? '' : safeSerializeDebugPayload(extra);
}

export const log = {
  info(message: string, extra?: unknown) {
    console.log('[local-policy-agent]', message, formatExtra(extra));
  },
  warn(message: string, extra?: unknown) {
    console.warn('[local-policy-agent]', message, formatExtra(extra));
  },
  error(message: string, extra?: unknown) {
    console.error('[local-policy-agent]', message, formatExtra(extra));
  },
};
