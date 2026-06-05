export const PAGE_STATE_LIST = [
  'real_policy_detail',
  'policy_list',
  'portal_index',
  'directory_shell',
  'template_shell',
  'empty_page',
  'attachment_landing',
  'intermediate_page',
  'error_shell',
  'shell_redirect'
];

export const CRAWL_OUTCOME_LIST = [
  'success_real_detail',
  'success_attachment_detail',
  'fail_no_terminal_detail',
  'fail_directory_shell',
  'fail_template_shell',
  'fail_empty_body',
  'fail_error_page',
  'fail_attachment_unusable',
  'fail_loop_or_no_progress'
];

export const PAGE_STATES = new Set(PAGE_STATE_LIST);
export const CRAWL_OUTCOMES = new Set(CRAWL_OUTCOME_LIST);

export const POLICY_SUCCESS_OUTCOMES = new Set([
  'success_real_detail',
  'success_attachment_detail'
]);

export const EXPLICIT_HARD_FAILURE_OUTCOMES = new Set([
  'fail_loop_or_no_progress'
]);

export const TERMINAL_FAILURE_PAGE_STATES = new Set([
  'directory_shell',
  'template_shell',
  'empty_page',
  'error_shell',
  'shell_redirect',
  'policy_list',
  'portal_index'
]);

export function isPolicySuccessOutcome(outcome) {
  return POLICY_SUCCESS_OUTCOMES.has(outcome);
}

export function isExplicitHardFailureOutcome(outcome) {
  return EXPLICIT_HARD_FAILURE_OUTCOMES.has(outcome);
}

export function isTerminalFailurePageState(pageState) {
  return TERMINAL_FAILURE_PAGE_STATES.has(pageState);
}
