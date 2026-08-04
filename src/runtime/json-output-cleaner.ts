export interface JsonOutputCleanResult {
  candidateText: string | null;
  steps: string[];
  candidateCount: number;
  reason?: string;
}

function scanBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== '{' && character !== '[') continue;
    if (depth === 0) start = index;
    depth += 1;
    for (let cursor = index + 1; cursor < text.length && depth > 0; cursor += 1) {
      const nested = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (nested === '\\') escaped = true;
        else if (nested === '"') inString = false;
        continue;
      }
      if (nested === '"') {
        inString = true;
      } else if (nested === '{' || nested === '[') {
        depth += 1;
      } else if (nested === '}' || nested === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, cursor + 1));
          index = cursor;
          break;
        }
      }
    }
    if (depth !== 0) return candidates;
    depth = 0;
  }
  return candidates;
}

function validJsonCandidate(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

export function cleanJsonModelOutput(rawText: string): JsonOutputCleanResult {
  const trimmed = rawText.trim();
  if (validJsonCandidate(trimmed)) {
    return { candidateText: trimmed, steps: ['fast_path'], candidateCount: 1 };
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  if (fenced && validJsonCandidate(fenced)) {
    return { candidateText: fenced, steps: ['markdown_fence'], candidateCount: 1 };
  }

  const candidates = scanBalancedJsonCandidates(trimmed).filter(validJsonCandidate);
  if (candidates.length === 1) {
    return { candidateText: candidates[0], steps: ['extract_unique_balanced_json'], candidateCount: 1 };
  }
  if (candidates.length > 1) {
    return {
      candidateText: null,
      steps: ['extract_balanced_json'],
      candidateCount: candidates.length,
      reason: 'multiple_valid_json_candidates',
    };
  }
  return {
    candidateText: null,
    steps: [],
    candidateCount: 0,
    reason: 'no_valid_json_candidate',
  };
}
