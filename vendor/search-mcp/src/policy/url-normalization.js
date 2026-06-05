const TRACKING_PARAM_PATTERN = /^(utm_.+|spm|from|source|src|ref|ref_src)$/i;

export function normalizePolicyUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'https:';
    parsed.hash = '';

    const kept = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!TRACKING_PARAM_PATTERN.test(key)) {
        kept.push([key, value]);
      }
    }

    parsed.search = '';
    for (const [key, value] of kept) {
      parsed.searchParams.append(key, value);
    }

    return parsed.toString();
  } catch {
    return url;
  }
}
