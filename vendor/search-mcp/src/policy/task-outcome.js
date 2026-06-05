import { isExplicitHardFailureOutcome, isTerminalFailurePageState } from './models.js';

function isOfficialNonCommentary(result) {
  return Boolean(result?.isOfficial) && !result?.isCommentary;
}

function isSuccessfulOfficialResult(result) {
  if (!isOfficialNonCommentary(result)) return false;

  if (
    result?.pageState === 'real_policy_detail' &&
    result?.crawlOutcome === 'success_real_detail'
  ) {
    return true;
  }

  return (
    result?.pageState === 'attachment_landing' &&
    result?.crawlOutcome === 'success_attachment_detail' &&
    result?.attachmentConfidence === 'strong'
  );
}

function isObviousFailure(result) {
  return (
    isTerminalFailurePageState(result?.pageState) ||
    isExplicitHardFailureOutcome(result?.crawlOutcome)
  );
}

export function evaluatePolicyTaskOutcome(results) {
  const items = Array.isArray(results) ? results : [];

  if (items.some(isSuccessfulOfficialResult)) {
    return 'success';
  }

  if (items.some((result) => isOfficialNonCommentary(result) && !isObviousFailure(result))) {
    return 'partial_success';
  }

  return 'failure';
}
