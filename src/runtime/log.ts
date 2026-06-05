export const log = {
  info(message: string, extra?: unknown) {
    console.log('[local-policy-agent]', message, extra ?? '');
  },
  warn(message: string, extra?: unknown) {
    console.warn('[local-policy-agent]', message, extra ?? '');
  },
  error(message: string, extra?: unknown) {
    console.error('[local-policy-agent]', message, extra ?? '');
  },
};
