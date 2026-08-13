import {evaluateRuleList} from './rules.mjs';

const SUSPENDED_POLICY_DEFAULTS = Object.freeze({
  audio: true,
  form: true,
  mode: 'time-based',
  paused: false,
  period: 10 * 60,
  pinned: false,
  whitelist: [],
  'notification.permission': false,
  'whitelist-url': [],
  'whitelist.session': []
});

const ruleList = value => value === undefined ? [] : value;

const matchesRule = (rules, hostname, href) => {
  const result = evaluateRuleList(ruleList(rules), hostname, href);
  return result.valid && result.matched;
};

const rejectedReason = (label, result) => `${label} rules were rejected: ${
  result.rejected[0]?.reason || result.reason || 'invalid rule list'}`;

const tabLocation = tab => {
  const href = tab?.pendingUrl || tab?.url;
  if (typeof href !== 'string' || href.length === 0) {
    return {error: 'tab URL is unavailable'};
  }

  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        error: `tab URL is not renderer-safe: ${url.protocol || '(none)'}`,
        href,
        hostname: url.hostname
      };
    }
    return {href, hostname: url.hostname};
  }
  catch (error) {
    return {error: `invalid tab URL: ${href}`};
  }
};

const suspendedProtectionReasons = (tab, policy = {}, now = Date.now()) => {
  const reasons = [];
  const location = tabLocation(tab);

  if (location.error) {
    reasons.push(location.error);
  }
  else {
    const whitelistResults = [policy.whitelist, policy['whitelist.session']]
      .map(rules => evaluateRuleList(ruleList(rules), location.hostname, location.href));
    const invalidWhitelist = whitelistResults.find(result => result.valid === false);
    if (invalidWhitelist) {
      reasons.push(rejectedReason('whitelist', invalidWhitelist));
    }
    else if (whitelistResults.some(result => result.matched)) {
      reasons.push('tab URL is protected by the whitelist');
    }
    if (policy.mode === 'url-based') {
      const urlListResult = evaluateRuleList(ruleList(policy['whitelist-url']),
        location.hostname, location.href);
      if (urlListResult.valid === false) {
        reasons.push(rejectedReason('URL-based discard', urlListResult));
      }
      else if (urlListResult.matched === false) {
        reasons.push('tab URL is outside the URL-based discard list');
      }
    }
  }

  if (tab?.active === true) {
    reasons.push('tab is active');
  }
  if (tab?.autoDiscardable === false) {
    reasons.push('tab is not automatically discardable');
  }
  if (policy.pinned === true && tab?.pinned === true) {
    reasons.push('pinned-tab protection is enabled');
  }
  if (policy.audio === true && tab?.audible === true) {
    reasons.push('tab is audible');
  }

  // A frozen renderer still retains state but cannot answer renderer-only
  // checks without activation, so normal commands fail closed. A physically
  // discarded renderer has already been torn down by the external suspender;
  // there is no remaining form/PiP state for our takeover to destroy. Static
  // URL/pin/audible/autoDiscardable/age protections above always apply to both.
  const rendererRetained = tab?.discarded !== true;
  if (rendererRetained && policy.form === true) {
    reasons.push('unsaved-form state cannot be verified while suspended');
  }
  if (rendererRetained && policy.audio === true && tab?.audible !== true) {
    reasons.push('picture-in-picture state cannot be verified while suspended');
  }
  if (rendererRetained && policy.paused === true) {
    reasons.push('paused-media state cannot be verified while suspended');
  }
  if (rendererRetained && policy['notification.permission'] === true) {
    reasons.push('notification permission cannot be verified while suspended');
  }

  const period = Math.max(0, Number(policy.period) || 0) * 1000;
  const lastAccessed = typeof tab?.lastAccessed === 'number' ? tab.lastAccessed : NaN;
  if (period > 0 && Number.isFinite(lastAccessed) === false) {
    reasons.push('last-accessed time is unavailable');
  }
  else if (period > 0 && now - lastAccessed < period) {
    reasons.push('tab is not old enough');
  }

  return reasons;
};

const classifySuspendedTarget = (tab, policy = {}, options = {}) => {
  const reasons = suspendedProtectionReasons(tab, policy, options.now);
  const shiftKey = options.shiftKey === true;

  if (reasons.length === 0) {
    return {
      action: 'allow',
      allowed: true,
      bypassed: false,
      protected: false,
      reasons,
      tab
    };
  }
  if (shiftKey) {
    return {
      action: 'bypass',
      allowed: true,
      bypassed: true,
      protected: false,
      reasons,
      tab
    };
  }
  return {
    action: 'protect',
    allowed: false,
    bypassed: false,
    protected: true,
    reason: reasons[0],
    reasons,
    tab
  };
};

const partitionSuspendedTargets = (tabs, policy = {}, options = {}) => {
  const allowed = [];
  const bypassed = [];
  const protectedTabs = [];

  for (const tab of tabs) {
    const decision = classifySuspendedTarget(tab, policy, options);
    if (decision.protected) {
      protectedTabs.push(decision);
    }
    else {
      allowed.push(tab);
      if (decision.bypassed) {
        bypassed.push(decision);
      }
    }
  }

  return {allowed, bypassed, protected: protectedTabs};
};

export {
  classifySuspendedTarget,
  matchesRule,
  partitionSuspendedTargets,
  SUSPENDED_POLICY_DEFAULTS,
  suspendedProtectionReasons,
  tabLocation
};
