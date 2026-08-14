// Failure causes are a privacy boundary shared by command execution, popup
// progress, the diagnostic journal, and support exports. Never add browser
// messages, URLs, tab identifiers, or other free-form values to this set.
const FAILURE_CAUSES = Object.freeze({
  METADATA_CHECK_FAILED: 'METADATA_CHECK_FAILED',
  NATIVE_POSTCONDITION_FAILED: 'NATIVE_POSTCONDITION_FAILED',
  NATIVE_REJECTED: 'NATIVE_REJECTED',
  NATIVE_TIMEOUT: 'NATIVE_TIMEOUT',
  OPERATION_FAILED: 'OPERATION_FAILED',
  OWNERSHIP_FINALIZATION_FAILED: 'OWNERSHIP_FINALIZATION_FAILED',
  OWNERSHIP_RESOLUTION_FAILED: 'OWNERSHIP_RESOLUTION_FAILED',
  RELEASE_FAILED: 'RELEASE_FAILED',
  SCOPE_QUERY_FAILED: 'SCOPE_QUERY_FAILED',
  TAKEOVER_FAILED: 'TAKEOVER_FAILED'
});

const FAILURE_CAUSE_POLICY = new Map([
  [FAILURE_CAUSES.METADATA_CHECK_FAILED, ['metadata-check', 'METADATA_CHECK_FAILED']],
  [FAILURE_CAUSES.NATIVE_POSTCONDITION_FAILED,
    ['native-discard', 'NATIVE_POSTCONDITION_FAILED']],
  [FAILURE_CAUSES.NATIVE_REJECTED, ['native-discard', 'NATIVE_REJECTED']],
  [FAILURE_CAUSES.NATIVE_TIMEOUT, ['native-discard', 'NATIVE_TIMEOUT']],
  [FAILURE_CAUSES.OPERATION_FAILED, ['tab-operation', 'OPERATION_FAILED']],
  [FAILURE_CAUSES.OWNERSHIP_FINALIZATION_FAILED,
    ['ownership-finalization', 'OWNERSHIP_FINALIZATION_FAILED']],
  [FAILURE_CAUSES.OWNERSHIP_RESOLUTION_FAILED,
    ['ownership-resolution', 'OWNERSHIP_RESOLUTION_FAILED']],
  [FAILURE_CAUSES.RELEASE_FAILED, ['release', 'RELEASE_FAILED']],
  [FAILURE_CAUSES.SCOPE_QUERY_FAILED, ['scope-query', 'SCOPE_QUERY_FAILED']],
  [FAILURE_CAUSES.TAKEOVER_FAILED, ['takeover', 'TAKEOVER_FAILED']]
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

export {
  FAILURE_CAUSES,
  FAILURE_CAUSE_POLICY,
  failureCauseFrom,
  failureCausePolicy,
  matchesFailureCausePolicy,
  normalizeFailureCause,
  safeFailureCause
};
