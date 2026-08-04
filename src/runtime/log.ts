import { safeSerializeDebugPayload } from './sanitize-debug.js';

function formatExtra(extra: unknown): string {
  return extra === undefined ? '' : safeSerializeDebugPayload(extra);
}

export const log = {
  info(message: string, extra?: unknown) {
    console.log('[nano-researcher]', message, formatExtra(extra));
  },
  warn(message: string, extra?: unknown) {
    console.warn('[nano-researcher]', message, formatExtra(extra));
  },
  error(message: string, extra?: unknown) {
    console.error('[nano-researcher]', message, formatExtra(extra));
  },
};
