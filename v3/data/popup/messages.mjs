const codeMessages = Object.freeze({
  POPUP_BUSY: 'popup_error_busy',
  POPUP_CANCELLED: 'popup_status_cancelled',
  POPUP_COMMAND_FAILED: 'popup_error_command_failed',
  POPUP_INTERRUPTED: 'popup_status_interrupted',
  POPUP_NO_ACTIVE_TAB: 'popup_error_no_active_tab',
  POPUP_TARGET_CHANGED: 'popup_error_target_changed'
});

const diagnosticReasonMessages = Object.freeze(Object.fromEntries([
  'POPUP_BUSY', 'POPUP_CANCELLED', 'POPUP_COMMAND_FAILED', 'POPUP_INTERRUPTED',
  'POPUP_NO_ACTIVE_TAB', 'POPUP_TARGET_CHANGED', 'TAB_ALREADY_OWNED',
  'TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE', 'TAB_CANCELLED', 'TAB_DISCARDED',
  'TAB_DISCARDED_VISUAL_UNAVAILABLE', 'TAB_FAILED', 'TAB_MISSING',
  'TAB_NO_SAFE_KEEPER', 'TAB_OWNERSHIP_UNKNOWN', 'TAB_PROTECTED', 'TAB_RELEASED',
  'TAB_RELEASE_REMAINS_FROZEN', 'TAB_SKIPPED', 'TAB_SUSPENSION_UNKNOWN',
  'TAB_UNSUPPORTED'
].map(code => [code, true])));

const diagnosticStatusMessages = Object.freeze({
  failed: 'popup_diagnostics_status_failed',
  skipped: 'popup_diagnostics_status_skipped',
  success: 'popup_diagnostics_status_success',
  succeeded: 'popup_diagnostics_status_success'
});

const message = (getMessage, key, substitutions) => {
  const value = getMessage(key, substitutions);
  return value || getMessage('popup_error_command_failed');
};

const optionalMessage = (getMessage, key, substitutions) =>
  getMessage(key, substitutions) || '';

const progressText = (snapshot, getMessage) => message(getMessage, 'popup_progress', [
  String(snapshot?.completed || 0),
  String(snapshot?.total || 0)
]);

const summaryText = (snapshot, getMessage) => message(getMessage, 'popup_result_summary', [
  String(snapshot?.summary?.success || 0),
  String(snapshot?.summary?.skipped || 0),
  String(snapshot?.summary?.failed || 0)
]);

const visualUnavailableCount = snapshot => Object.values(snapshot?.outcomes || {}).filter(
  outcome => ['TAB_DISCARDED_VISUAL_UNAVAILABLE',
    'TAB_ALREADY_OWNED_VISUAL_UNAVAILABLE'].includes(outcome?.code)
).length;
const visualUnavailableText = (snapshot, getMessage) => {
  const count = visualUnavailableCount(snapshot);
  return count > 0 ? message(getMessage, 'popup_visual_unavailable_warning', [String(count)]) : '';
};

const noSafeKeeperCount = snapshot => Object.values(snapshot?.outcomes || {}).filter(
  outcome => outcome?.code === 'TAB_NO_SAFE_KEEPER'
).length;
const noSafeKeeperText = (snapshot, getMessage) => {
  const count = noSafeKeeperCount(snapshot);
  return count > 0 ? message(getMessage, 'popup_no_safe_keeper_warning', [String(count)]) : '';
};

const releaseRemainsFrozenCount = snapshot => Object.values(snapshot?.outcomes || {}).filter(
  outcome => outcome?.code === 'TAB_RELEASE_REMAINS_FROZEN'
).length;
const releaseRemainsFrozenText = (snapshot, getMessage) => {
  const count = releaseRemainsFrozenCount(snapshot);
  return count > 0 ? message(
    getMessage,
    'popup_release_remains_frozen_warning',
    [String(count)]
  ) : '';
};

const statusHeadlineText = (snapshot, getMessage) => {
  if (!snapshot) {
    return '';
  }
  if (snapshot.state === 'running') {
    return progressText(snapshot, getMessage);
  }
  if (snapshot.state === 'cancelling') {
    return message(getMessage, 'popup_status_cancelling');
  }
  const statusKey = snapshot.state === 'complete' ? 'popup_status_complete' :
    snapshot.state === 'partial' ? 'popup_status_partial' :
    snapshot.state === 'cancelled' ? 'popup_status_cancelled' :
      snapshot.state === 'interrupted' ? 'popup_status_interrupted' :
        codeMessages[snapshot.errorCode] || 'popup_status_failed';
  return message(getMessage, statusKey);
};

const statusText = (snapshot, getMessage) => {
  if (!snapshot) {
    return '';
  }
  return [statusHeadlineText(snapshot, getMessage),
    snapshot.state === 'running' || snapshot.state === 'cancelling' ? '' :
      summaryText(snapshot, getMessage),
    visualUnavailableText(snapshot, getMessage),
    noSafeKeeperText(snapshot, getMessage),
    releaseRemainsFrozenText(snapshot, getMessage)].filter(Boolean).join(' ');
};

const diagnosticReasonText = (code, getMessage) => diagnosticReasonMessages[code] ?
  optionalMessage(getMessage, 'popup_diagnostics_reason_default') : '';

const diagnosticStatusText = (status, getMessage) => optionalMessage(
  getMessage,
  diagnosticStatusMessages[status] || 'popup_diagnostics_status_failed'
);

const diagnosticRowText = (group, getMessage) => {
  const count = String(group?.count || 0);
  const status = diagnosticStatusText(group?.status, getMessage);
  const reason = diagnosticReasonText(group?.code, getMessage);
  if (group?.stage && group?.reasonCode) {
    return message(getMessage, 'popup_diagnostics_reason_row_detailed', [
      count,
      status,
      group.stage,
      group.reasonCode,
      group.code
    ]);
  }
  return message(getMessage, 'popup_diagnostics_reason_row', [
    count,
    status,
    reason,
    group?.code || 'POPUP_COMMAND_FAILED'
  ]);
};

const responseErrorText = (response, getMessage) => message(
  getMessage,
  codeMessages[response?.code || response?.errorCode] || 'popup_error_command_failed'
);

const announcementKey = snapshot => snapshot ? [
  snapshot.jobId,
  snapshot.state,
  snapshot.completed,
  snapshot.total,
  snapshot.summary?.success || 0,
  snapshot.summary?.skipped || 0,
  snapshot.summary?.failed || 0,
  snapshot.errorCode || '',
  visualUnavailableCount(snapshot),
  noSafeKeeperCount(snapshot),
  releaseRemainsFrozenCount(snapshot)
].join(':') : '';

export {
  announcementKey,
  codeMessages,
  diagnosticReasonMessages,
  diagnosticReasonText,
  diagnosticRowText,
  diagnosticStatusText,
  noSafeKeeperCount,
  noSafeKeeperText,
  progressText,
  releaseRemainsFrozenCount,
  releaseRemainsFrozenText,
  responseErrorText,
  statusHeadlineText,
  statusText,
  summaryText,
  visualUnavailableCount,
  visualUnavailableText
};
