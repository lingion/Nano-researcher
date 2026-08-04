export const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
export const ANDROID_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36';

export type UserAgentProfile = 'desktop' | 'android';

export function userAgentFor(profile: UserAgentProfile = 'desktop'): string {
  return profile === 'android' ? ANDROID_USER_AGENT : DESKTOP_USER_AGENT;
}
