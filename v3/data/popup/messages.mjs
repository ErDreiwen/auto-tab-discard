const codeMessages = Object.freeze({
  POPUP_BUSY: 'popup_error_busy',
  POPUP_CANCELLED: 'popup_status_cancelled',
  POPUP_COMMAND_FAILED: 'popup_error_command_failed',
  POPUP_INTERRUPTED: 'popup_status_interrupted',
  POPUP_NO_ACTIVE_TAB: 'popup_error_no_active_tab',
  POPUP_TARGET_CHANGED: 'popup_error_target_changed'
});

const message = (getMessage, key, substitutions) => {
  const value = getMessage(key, substitutions);
  return value || getMessage('popup_error_command_failed');
};

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

const statusText = (snapshot, getMessage) => {
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
  return [message(getMessage, statusKey), summaryText(snapshot, getMessage),
    visualUnavailableText(snapshot, getMessage),
    noSafeKeeperText(snapshot, getMessage),
    releaseRemainsFrozenText(snapshot, getMessage)].filter(Boolean).join(' ');
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
  noSafeKeeperCount,
  noSafeKeeperText,
  progressText,
  releaseRemainsFrozenCount,
  releaseRemainsFrozenText,
  responseErrorText,
  statusText,
  summaryText,
  visualUnavailableCount,
  visualUnavailableText
};
