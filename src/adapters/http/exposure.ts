export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

export function assertSafeHttpExposure(host: string, authToken?: string): void {
  if (!isLoopbackHost(host) && !authToken?.trim()) {
    throw new Error('RESEARCH_HTTP_AUTH_TOKEN is required when RESEARCH_HTTP_HOST is not loopback.');
  }
}
