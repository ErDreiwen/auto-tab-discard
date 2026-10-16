// Failure causes are a privacy boundary shared by command execution, popup
// progress, the diagnostic journal, and support exports. Never add browser
// messages, URLs, tab identifiers, or other free-form values to this set.
const FAILURE_CAUSES = Object.freeze({
  CLASSIFICATION_INCOMPLETE: 'CLASSIFICATION_INCOMPLETE',
  METADATA_EVALUATION_FAILED: 'METADATA_EVALUATION_FAILED',
  METADATA_CHECK_FAILED: 'METADATA_CHECK_FAILED',
  METADATA_NO_INSPECTABLE_DOCUMENT: 'METADATA_NO_INSPECTABLE_DOCUMENT',
  METADATA_SCAN_CAPACITY: 'METADATA_SCAN_CAPACITY',
  METADATA_SCAN_FAILED: 'METADATA_SCAN_FAILED',
  METADATA_SCAN_TIMEOUT: 'METADATA_SCAN_TIMEOUT',
  METADATA_UNAVAILABLE: 'METADATA_UNAVAILABLE',
  NATIVE_POSTCONDITION_FAILED: 'NATIVE_POSTCONDITION_FAILED',
  NATIVE_REJECTED: 'NATIVE_REJECTED',
  NATIVE_TIMEOUT: 'NATIVE_TIMEOUT',
  OPERATION_FAILED: 'OPERATION_FAILED',
  OWNERSHIP_FINALIZATION_FAILED: 'OWNERSHIP_FINALIZATION_FAILED',
  OWNERSHIP_RESOLUTION_FAILED: 'OWNERSHIP_RESOLUTION_FAILED',
  PLUGIN_FILTER_FAILED: 'PLUGIN_FILTER_FAILED',
  RELEASE_FAILED: 'RELEASE_FAILED',
  SCOPE_QUERY_FAILED: 'SCOPE_QUERY_FAILED',
  SPLIT_VIEW_QUERY_FAILED: 'SPLIT_VIEW_QUERY_FAILED',
  TAKEOVER_FAILED: 'TAKEOVER_FAILED',
  TAKEOVER_OWNERSHIP_FAILED: 'TAKEOVER_OWNERSHIP_FAILED',
  TAKEOVER_PREPARE_FAILED: 'TAKEOVER_PREPARE_FAILED',
  TAKEOVER_TARGET_CHANGED: 'TAKEOVER_TARGET_CHANGED',
  TAKEOVER_WAKE_FAILED: 'TAKEOVER_WAKE_FAILED',
  TARGET_UNAVAILABLE: 'TARGET_UNAVAILABLE',
  UNSUPPORTED_PAGE: 'UNSUPPORTED_PAGE',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
  URL_POLICY_EVALUATION_FAILED: 'URL_POLICY_EVALUATION_FAILED'
});

const FAILURE_CAUSE_POLICY = new Map([
  [FAILURE_CAUSES.CLASSIFICATION_INCOMPLETE,
    ['classification', 'CLASSIFICATION_INCOMPLETE']],
  [FAILURE_CAUSES.METADATA_EVALUATION_FAILED,
    ['metadata-check', 'METADATA_EVALUATION_FAILED']],
  [FAILURE_CAUSES.METADATA_CHECK_FAILED, ['metadata-check', 'METADATA_CHECK_FAILED']],
  [FAILURE_CAUSES.METADATA_NO_INSPECTABLE_DOCUMENT,
    ['metadata-check', 'METADATA_NO_INSPECTABLE_DOCUMENT']],
  [FAILURE_CAUSES.METADATA_SCAN_CAPACITY, ['metadata-scan', 'METADATA_SCAN_CAPACITY']],
  [FAILURE_CAUSES.METADATA_SCAN_FAILED, ['metadata-scan', 'METADATA_SCAN_FAILED']],
  [FAILURE_CAUSES.METADATA_SCAN_TIMEOUT, ['metadata-scan', 'METADATA_SCAN_TIMEOUT']],
  [FAILURE_CAUSES.METADATA_UNAVAILABLE, ['metadata-check', 'METADATA_UNAVAILABLE']],
  [FAILURE_CAUSES.NATIVE_POSTCONDITION_FAILED,
    ['native-discard', 'NATIVE_POSTCONDITION_FAILED']],
  [FAILURE_CAUSES.NATIVE_REJECTED, ['native-discard', 'NATIVE_REJECTED']],
  [FAILURE_CAUSES.NATIVE_TIMEOUT, ['native-discard', 'NATIVE_TIMEOUT']],
  [FAILURE_CAUSES.OPERATION_FAILED, ['tab-operation', 'OPERATION_FAILED']],
  [FAILURE_CAUSES.OWNERSHIP_FINALIZATION_FAILED,
    ['ownership-finalization', 'OWNERSHIP_FINALIZATION_FAILED']],
  [FAILURE_CAUSES.OWNERSHIP_RESOLUTION_FAILED,
    ['ownership-resolution', 'OWNERSHIP_RESOLUTION_FAILED']],
  [FAILURE_CAUSES.PLUGIN_FILTER_FAILED, ['plugin-filter', 'PLUGIN_FILTER_FAILED']],
  [FAILURE_CAUSES.RELEASE_FAILED, ['release', 'RELEASE_FAILED']],
  [FAILURE_CAUSES.SCOPE_QUERY_FAILED, ['scope-query', 'SCOPE_QUERY_FAILED']],
  [FAILURE_CAUSES.SPLIT_VIEW_QUERY_FAILED, ['split-view', 'SPLIT_VIEW_QUERY_FAILED']],
  [FAILURE_CAUSES.TAKEOVER_FAILED, ['takeover', 'TAKEOVER_FAILED']],
  [FAILURE_CAUSES.TAKEOVER_OWNERSHIP_FAILED, ['takeover', 'TAKEOVER_OWNERSHIP_FAILED']],
  [FAILURE_CAUSES.TAKEOVER_PREPARE_FAILED, ['takeover', 'TAKEOVER_PREPARE_FAILED']],
  [FAILURE_CAUSES.TAKEOVER_TARGET_CHANGED, ['takeover', 'TAKEOVER_TARGET_CHANGED']],
  [FAILURE_CAUSES.TAKEOVER_WAKE_FAILED, ['takeover', 'TAKEOVER_WAKE_FAILED']],
  [FAILURE_CAUSES.TARGET_UNAVAILABLE, ['eligibility', 'TARGET_UNAVAILABLE']],
  [FAILURE_CAUSES.UNSUPPORTED_PAGE, ['eligibility', 'UNSUPPORTED_PAGE']],
  [FAILURE_CAUSES.UNSUPPORTED_SCHEME, ['eligibility', 'UNSUPPORTED_SCHEME']],
  [FAILURE_CAUSES.URL_POLICY_EVALUATION_FAILED,
    ['url-policy', 'URL_POLICY_EVALUATION_FAILED']]
]);

const SAFE_FAILURE_CAUSES = new Set(Object.values(FAILURE_CAUSES));

const safeFailureCause = value => SAFE_FAILURE_CAUSES.has(value) ? value : undefined;
const normalizeFailureCause = value => safeFailureCause(value) || FAILURE_CAUSES.OPERATION_FAILED;
const failureCauseFrom = (
  value,
  fallback = FAILURE_CAUSES.OPERATION_FAILED,
  key = 'failureCause'
) => {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      return safeFailureCause(descriptor.value) || normalizeFailureCause(fallback);
    }
  }
  return normalizeFailureCause(fallback);
};
const failureCausePolicy = value => FAILURE_CAUSE_POLICY.get(normalizeFailureCause(value));
const matchesFailureCausePolicy = (stage, reasonCode) => [...FAILURE_CAUSE_POLICY.values()]
  .some(policy => stage === policy[0] && reasonCode === policy[1]);

// Protection rules explain a deliberate skip, not a failure. They are a
// separate fixed allowlist carried as `protectionRule` on TAB_PROTECTED
// outcomes only, under the same privacy boundary as failure causes.
const PROTECTION_RULES = Object.freeze({
  ACTIVE_TAB: 'PROTECTED_ACTIVE_TAB',
  ALREADY_DISCARDED: 'PROTECTED_ALREADY_DISCARDED',
  AUDIBLE: 'PROTECTED_AUDIBLE',
  AUTO_DISCARDABLE_OFF: 'PROTECTED_AUTO_DISCARDABLE_OFF',
  DISCARD_IN_PROGRESS: 'PROTECTED_DISCARD_IN_PROGRESS',
  DOCUMENT_NOT_READY: 'PROTECTED_DOCUMENT_NOT_READY',
  FORM_INPUT: 'PROTECTED_FORM_INPUT',
  MEDIA_PAUSED: 'PROTECTED_MEDIA_PAUSED',
  NOTIFICATION_PERMISSION: 'PROTECTED_NOTIFICATION_PERMISSION',
  PINNED: 'PROTECTED_PINNED',
  PLUGIN_FILTER: 'PROTECTED_PLUGIN_FILTER',
  RENDERER_REQUIRED: 'PROTECTED_RENDERER_REQUIRED',
  SPLIT_VIEW: 'PROTECTED_SPLIT_VIEW',
  STATE_UNVERIFIABLE: 'PROTECTED_STATE_UNVERIFIABLE',
  SUSPENSION_UNKNOWN: 'PROTECTED_SUSPENSION_UNKNOWN',
  SYSTEM_STATE: 'PROTECTED_SYSTEM_STATE',
  TAB_AGE: 'PROTECTED_TAB_AGE',
  TAB_COUNT: 'PROTECTED_TAB_COUNT',
  URL_ALLOWLIST: 'PROTECTED_URL_ALLOWLIST',
  WHITELIST: 'PROTECTED_WHITELIST',
  UNSPECIFIED: 'PROTECTION_RULE'
});
const PROTECTION_RULE_POLICY = new Map(Object.values(PROTECTION_RULES)
  .map(rule => [rule, ['eligibility', rule]]));
// Ordered: the first match names the rule. Unknown reasons stay unspecified.
const PROTECTION_REASON_RULES = [
  [/cannot be verified while (?:frozen|suspended)/, PROTECTION_RULES.STATE_UNVERIFIABLE],
  [/^(?:tab is active|active-tab protection|tab became active)/, PROTECTION_RULES.ACTIVE_TAB],
  [/^tab is already discarded/, PROTECTION_RULES.ALREADY_DISCARDED],
  [/^(?:tab is audible|tab has playing audio)/, PROTECTION_RULES.AUDIBLE],
  [/^tab is not automatically discardable/, PROTECTION_RULES.AUTO_DISCARDABLE_OFF],
  [/^(?:direct native discard is still settling|a discard transaction already owns)/,
    PROTECTION_RULES.DISCARD_IN_PROGRESS],
  [/^tab document is not ready/, PROTECTION_RULES.DOCUMENT_NOT_READY],
  [/^tab has unsaved form input/, PROTECTION_RULES.FORM_INPUT],
  [/^tab has a paused media player/, PROTECTION_RULES.MEDIA_PAUSED],
  [/^tab has notification permission/, PROTECTION_RULES.NOTIFICATION_PERMISSION],
  [/^pinned-tab protection/, PROTECTION_RULES.PINNED],
  [/^tab was excluded by plug-in filter/, PROTECTION_RULES.PLUGIN_FILTER],
  [/normal targeted metadata discard requires a renderer$/, PROTECTION_RULES.RENDERER_REQUIRED],
  [/^tab is part of a focused split view/, PROTECTION_RULES.SPLIT_VIEW],
  [/^(?:tab suspension state is|unrecognized (?:frozen|discarded) state)/,
    PROTECTION_RULES.SUSPENSION_UNKNOWN],
  [/^targeted discard (?:requires the configured idle state|is disabled while)/,
    PROTECTION_RULES.SYSTEM_STATE],
  [/^(?:tab is younger than|tab is not old enough|last-accessed time is unavailable)/,
    PROTECTION_RULES.TAB_AGE],
  [/^(?:configured tab-count floor|targeted discard limit retained)/, PROTECTION_RULES.TAB_COUNT],
  [/^tab URL (?:does not match the URL-based allowlist|is outside the URL-based discard list)/,
    PROTECTION_RULES.URL_ALLOWLIST],
  [/^tab URL is protected by the (?:session or permanent )?whitelist/, PROTECTION_RULES.WHITELIST]
];

const safeProtectionRule = value => PROTECTION_RULE_POLICY.has(value) ? value : undefined;
const protectionRuleFor = reason => typeof reason === 'string' &&
  PROTECTION_REASON_RULES.find(([pattern]) => pattern.test(reason))?.[1] ||
  PROTECTION_RULES.UNSPECIFIED;
const protectionRuleFrom = (value, key = 'protectionRule') => {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      return safeProtectionRule(descriptor.value) || PROTECTION_RULES.UNSPECIFIED;
    }
  }
  return PROTECTION_RULES.UNSPECIFIED;
};
const protectionRulePolicy = value => PROTECTION_RULE_POLICY.get(
  safeProtectionRule(value) || PROTECTION_RULES.UNSPECIFIED
);
const matchesProtectionRulePolicy = (stage, reasonCode) => stage === 'eligibility' &&
  PROTECTION_RULE_POLICY.has(reasonCode);

export {
  FAILURE_CAUSES,
  FAILURE_CAUSE_POLICY,
  failureCauseFrom,
  failureCausePolicy,
  matchesFailureCausePolicy,
  matchesProtectionRulePolicy,
  normalizeFailureCause,
  PROTECTION_RULES,
  protectionRuleFor,
  protectionRuleFrom,
  protectionRulePolicy,
  safeFailureCause,
  safeProtectionRule
};
