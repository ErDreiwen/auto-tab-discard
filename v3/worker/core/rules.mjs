const RULE_VALIDATION_REVISION = 1;

const RULE_LIMITS = Object.freeze({
  cacheEntries: 32,
  groupDepth: 8,
  groups: 16,
  inputLength: 4096,
  patternLength: 256,
  repeatMaximum: 1000,
  rules: 128
});

// Existing callers historically consumed `true` or `undefined`. A rejected
// ruleset must be truthy for exclusion lists but must not compare equal to
// `true` for URL-based allow lists. This sentinel therefore makes both legacy
// call shapes fail closed without evaluating any rejected expression.
const REJECTED_RULE_MATCH = Object.freeze({
  rejected: true
});

const cache = new Map();
const cacheStats = {
  compilations: 0,
  hits: 0,
  misses: 0
};

const rejection = (code, reason, index = null, rule) => ({
  code,
  index,
  reason,
  ...(typeof rule === 'string' ? {rule} : {})
});

const addAtom = (context, atom) => {
  context.atoms.push(atom);
  context.branchHasContent = true;
  context.consuming ||= atom.kind !== 'assertion' && atom.consuming !== false;
  context.containsAlternation ||= atom.containsAlternation === true;
  context.containsQuantifier ||= atom.containsQuantifier === true;
};

const escapedAtom = (pattern, index) => {
  const character = pattern[index + 1];
  if (character === undefined) {
    return {error: {code: 'invalid-escape', reason: 'regular expression ends with an escape'}};
  }
  if (/\d/.test(character) || character === 'k' || character === 'g') {
    return {
      error: {
        code: 'backreference',
        reason: 'backreferences and numeric or named escape references are not allowed'
      }
    };
  }
  if (character === 'u' || character === 'x') {
    const length = character === 'u' ? 4 : 2;
    const digits = pattern.slice(index + 2, index + 2 + length);
    if (digits.length !== length || /^[0-9a-f]+$/i.test(digits) === false) {
      return {
        error: {
          code: 'invalid-escape',
          reason: `${character === 'u' ? 'Unicode' : 'hexadecimal'} escapes must use exactly ${length} hex digits`
        }
      };
    }
    const value = String.fromCharCode(Number.parseInt(digits, 16));
    if (/\p{Cc}/u.test(value)) {
      return {
        error: {code: 'control-character', reason: 'escaped control characters are not allowed'}
      };
    }
    return {
      atom: {kind: 'literal', signature: `literal:${value}`},
      end: index + 1 + length
    };
  }
  if (character === 'c') {
    const control = pattern[index + 2];
    if (!control || /[A-Za-z]/.test(control) === false) {
      return {
        error: {code: 'invalid-escape', reason: 'control escapes must be followed by an ASCII letter'}
      };
    }
    return {
      error: {code: 'control-character', reason: 'escaped control characters are not allowed'}
    };
  }
  if (character === 'p' || character === 'P') {
    return {
      error: {code: 'unsupported-escape', reason: 'Unicode property escapes are not allowed'}
    };
  }
  if (character === 'b' || character === 'B') {
    return {
      atom: {kind: 'assertion', signature: `assertion:${character}`},
      end: index + 1
    };
  }
  if ('dDsSwW'.includes(character)) {
    return {
      atom: {kind: 'class', signature: `class:${character}`},
      end: index + 1
    };
  }
  const escapedLiterals = {
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v'
  };
  const value = escapedLiterals[character] ?? character;
  if (/\p{Cc}/u.test(value)) {
    return {
      error: {code: 'control-character', reason: 'escaped control characters are not allowed'}
    };
  }
  return {
    atom: {kind: 'literal', signature: `literal:${value}`},
    end: index + 1
  };
};

const atomsMayOverlap = (left, right) => {
  if (left.kind === 'literal' && right.kind === 'literal') {
    return left.signature === right.signature;
  }
  if (left.kind === 'assertion' || right.kind === 'assertion') {
    return false;
  }
  return true;
};

const parseQuantifier = (pattern, index) => {
  const character = pattern[index];
  if (character === '?') {
    return {end: index, maximum: 1, minimum: 0, variable: true};
  }
  if (character === '*') {
    return {end: index, maximum: Infinity, minimum: 0, variable: true};
  }
  if (character === '+') {
    return {end: index, maximum: Infinity, minimum: 1, variable: true};
  }
  if (character !== '{') {
    return null;
  }

  const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(index));
  if (!match) {
    return {error: 'malformed repetition quantifier'};
  }
  const minimum = Number(match[1]);
  const maximum = match[2] === undefined ? minimum :
    (match[3] === '' ? Infinity : Number(match[3]));
  if (minimum > RULE_LIMITS.repeatMaximum ||
      (maximum !== Infinity && maximum > RULE_LIMITS.repeatMaximum)) {
    return {error: `repetition exceeds ${RULE_LIMITS.repeatMaximum}`};
  }
  if (maximum !== Infinity && minimum > maximum) {
    return {error: 'repetition minimum exceeds its maximum'};
  }
  return {
    end: index + match[0].length - 1,
    maximum,
    minimum,
    variable: minimum !== maximum
  };
};

const validatePattern = (pattern, compile = false) => {
  if (pattern.length === 0) {
    return {code: 'empty-pattern', reason: 'regular expression is empty'};
  }
  if (pattern.length > RULE_LIMITS.patternLength) {
    return {
      code: 'pattern-too-long',
      reason: `regular expression exceeds ${RULE_LIMITS.patternLength} characters`
    };
  }
  if (/\p{Cc}/u.test(pattern)) {
    return {code: 'control-character', reason: 'regular expression contains a control character'};
  }

  const root = {
    atoms: [],
    branchHasContent: false,
    consuming: false,
    containsAlternation: false,
    containsQuantifier: false,
    wildcardQuantifiers: 0
  };
  const stack = [root];
  const expansiveAtoms = [];
  let groups = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const context = stack[stack.length - 1];
    const character = pattern[index];

    if (character === '\\') {
      const escaped = escapedAtom(pattern, index);
      if (escaped.error) {
        return escaped.error;
      }
      addAtom(context, escaped.atom);
      index = escaped.end;
      continue;
    }

    if (character === '[') {
      let closed = false;
      let escaped = false;
      let cursor = index + 1;
      for (; cursor < pattern.length; cursor += 1) {
        const current = pattern[cursor];
        if (escaped) {
          if (/\d/.test(current) || current === 'k' || current === 'g') {
            return {
              code: 'backreference',
              reason: 'numeric or named escape references are not allowed in character classes'
            };
          }
          escaped = false;
        }
        else if (current === '\\') {
          escaped = true;
        }
        else if (current === ']') {
          closed = true;
          break;
        }
      }
      if (!closed) {
        return {code: 'invalid-class', reason: 'character class is not closed'};
      }
      addAtom(context, {
        kind: 'class',
        signature: `class:${pattern.slice(index, cursor + 1)}`
      });
      index = cursor;
      continue;
    }

    if (character === '(') {
      if (pattern[index + 1] === '?') {
        if (pattern[index + 2] !== ':') {
          return {
            code: 'unsupported-group',
            reason: 'lookaround, lookbehind, named groups, and inline modifiers are not allowed'
          };
        }
        index += 2;
      }
      groups += 1;
      if (groups > RULE_LIMITS.groups || stack.length > RULE_LIMITS.groupDepth) {
        return {code: 'group-limit', reason: 'regular expression has too many or too-deep groups'};
      }
      stack.push({
        atoms: [],
        branchHasContent: false,
        consuming: false,
        containsAlternation: false,
        containsQuantifier: false,
        wildcardQuantifiers: 0
      });
      continue;
    }

    if (character === ')') {
      if (stack.length === 1) {
        return {code: 'unbalanced-group', reason: 'regular expression has an unmatched closing group'};
      }
      const group = stack.pop();
      if (group.containsAlternation && group.branchHasContent === false) {
        return {code: 'empty-alternative', reason: 'empty regular-expression alternatives are not allowed'};
      }
      if (group.branchHasContent === false) {
        return {code: 'empty-group', reason: 'empty regular-expression groups are not allowed'};
      }
      addAtom(stack[stack.length - 1], {
        containsAlternation: group.containsAlternation,
        containsQuantifier: group.containsQuantifier,
        consuming: group.consuming,
        kind: 'group',
        signature: 'group'
      });
      continue;
    }

    if (character === '|') {
      if (context.branchHasContent === false) {
        return {code: 'empty-alternative', reason: 'empty regular-expression alternatives are not allowed'};
      }
      context.containsAlternation = true;
      context.atoms = [];
      context.branchHasContent = false;
      continue;
    }

    if ('?*+{'.includes(character)) {
      const quantifier = parseQuantifier(pattern, index);
      if (quantifier?.error) {
        return {code: 'invalid-quantifier', reason: quantifier.error};
      }
      const atom = context.atoms[context.atoms.length - 1];
      if (!quantifier || !atom || atom.kind === 'assertion' || atom.consuming === false) {
        return {code: 'invalid-quantifier', reason: 'quantifier has no safe consuming atom'};
      }
      if (atom.quantifier || pattern[index - 1] === '}') {
        return {code: 'nested-quantifier', reason: 'nested quantifiers are not allowed'};
      }
      if (atom.kind === 'group' && atom.containsQuantifier) {
        return {code: 'nested-quantifier', reason: 'nested quantifiers are not allowed'};
      }
      if (atom.kind === 'group' && atom.containsAlternation) {
        return {
          code: 'ambiguous-alternation',
          reason: 'quantified alternation is not allowed because its branches may overlap'
        };
      }

      const previous = context.atoms[context.atoms.length - 2];
      const previousExpansive = previous?.quantifier?.maximum === Infinity ||
        (previous?.quantifier?.variable && previous.quantifier.maximum > 1);
      const currentExpansive = quantifier.maximum > 1;
      if (previousExpansive && currentExpansive && atomsMayOverlap(previous, atom)) {
        return {
          code: 'ambiguous-quantifiers',
          reason: 'adjacent variable quantifiers may consume the same input'
        };
      }
      if (atom.kind === 'dot' && quantifier.variable) {
        context.wildcardQuantifiers += 1;
        if (context.wildcardQuantifiers > 1) {
          return {
            code: 'ambiguous-wildcards',
            reason: 'multiple variable wildcard quantifiers are not allowed'
          };
        }
      }
      const expansive = quantifier.maximum > 1;
      if (expansive) {
        if (expansiveAtoms.some(previousAtom => atomsMayOverlap(previousAtom, atom))) {
          return {
            code: 'ambiguous-expansive-quantifiers',
            reason: 'multiple expansive quantifiers may consume the same input'
          };
        }
        expansiveAtoms.push(atom);
      }

      atom.quantifier = quantifier;
      context.containsQuantifier = true;
      index = quantifier.end;
      if (pattern[index + 1] === '?') {
        // Lazy repetition has the same bounded safety properties as its greedy
        // form. Consume the modifier so it is not mistaken for nesting.
        index += 1;
      }
      continue;
    }

    if (character === '^' || character === '$') {
      addAtom(context, {kind: 'assertion', signature: `assertion:${character}`});
      continue;
    }

    addAtom(context, character === '.' ? {
      kind: 'dot',
      signature: 'dot'
    } : {
      kind: 'literal',
      signature: `literal:${character}`
    });
  }

  if (stack.length !== 1) {
    return {code: 'unbalanced-group', reason: 'regular expression has an unclosed group'};
  }
  if (root.containsAlternation && root.branchHasContent === false) {
    return {code: 'empty-alternative', reason: 'empty regular-expression alternatives are not allowed'};
  }

  if (compile) {
    try {
      return {regexp: new RegExp(pattern), valid: true};
    }
    catch (error) {
      return {code: 'invalid-regexp', reason: 'regular expression is not valid JavaScript syntax'};
    }
  }
  return {valid: true};
};

const parseTrashRule = rule => {
  const match = /^(?:(re):)?([^@]+?)(?:@(\d+\w*))?$/.exec(rule);
  if (!match) {
    return {
      error: rejection('invalid-trash-rule',
        'trash rule must be an expression optionally followed by @ and a numeric interval')
    };
  }
  return {
    expression: match[2],
    interval: match[3],
    type: match[1] === 're' ? 'regexp' : 'plain'
  };
};

const parseRule = (rule, format) => {
  if (format === 'trash') {
    return parseTrashRule(rule);
  }
  if (format === 'plain') {
    return {expression: rule, type: 'plain'};
  }
  if (rule.startsWith('re:')) {
    return {expression: rule.slice(3), type: 'regexp'};
  }
  return {expression: rule, type: 'plain'};
};

const validateAndCompileRuleList = (value, options = {}) => {
  const format = options.format || 'standard';
  const compile = options.compile === true;
  if (!['plain', 'standard', 'trash'].includes(format)) {
    return {
      accepted: [],
      ok: false,
      rejected: [rejection('unsupported-format', 'rule-list format is not supported')],
      revision: RULE_VALIDATION_REVISION
    };
  }
  if (!Array.isArray(value)) {
    return {
      accepted: [],
      ok: false,
      rejected: [rejection('list-not-array', 'rule list must be an array')],
      revision: RULE_VALIDATION_REVISION
    };
  }
  if (value.length > RULE_LIMITS.rules) {
    return {
      accepted: [],
      ok: false,
      rejected: [rejection('too-many-rules', `rule list exceeds ${RULE_LIMITS.rules} entries`)],
      revision: RULE_VALIDATION_REVISION
    };
  }

  const accepted = [];
  const rejected = [];
  for (let index = 0; index < value.length; index += 1) {
    const rule = value[index];
    if (typeof rule !== 'string') {
      rejected.push(rejection('rule-not-string', 'rule must be a string', index));
      continue;
    }
    if (rule.length === 0) {
      rejected.push(rejection('empty-rule', 'rule must not be empty', index, rule));
      continue;
    }
    if (rule.length > RULE_LIMITS.patternLength + 32) {
      rejected.push(rejection('rule-too-long',
        `rule exceeds ${RULE_LIMITS.patternLength + 32} characters`, index, rule));
      continue;
    }
    if (/\p{Cc}/u.test(rule)) {
      rejected.push(rejection('control-character', 'rule contains a control character', index, rule));
      continue;
    }

    const parsed = parseRule(rule, format);
    if (parsed.error) {
      rejected.push({...parsed.error, index, rule});
      continue;
    }
    if (parsed.expression.length === 0) {
      rejected.push(rejection('empty-expression', 'rule expression must not be empty', index, rule));
      continue;
    }
    if (parsed.expression.length > RULE_LIMITS.patternLength) {
      rejected.push(rejection('pattern-too-long',
        `rule expression exceeds ${RULE_LIMITS.patternLength} characters`, index, rule));
      continue;
    }

    if (parsed.type === 'regexp') {
      const validation = validatePattern(parsed.expression, compile);
      if (!validation.valid) {
        rejected.push(rejection(validation.code, validation.reason, index, rule));
        continue;
      }
      const acceptedRule = {
        expression: parsed.expression,
        index,
        interval: parsed.interval,
        rule,
        type: 'regexp'
      };
      if (compile) {
        acceptedRule.regexp = validation.regexp;
      }
      accepted.push(acceptedRule);
    }
    else {
      accepted.push({
        expression: parsed.expression,
        index,
        interval: parsed.interval,
        rule,
        type: 'plain'
      });
    }
  }

  return {
    accepted,
    ok: rejected.length === 0,
    rejected,
    revision: RULE_VALIDATION_REVISION
  };
};

const publicRule = entry => ({
  expression: entry.expression,
  index: entry.index,
  interval: entry.interval,
  rule: entry.rule,
  type: entry.type
});

// Public validation is deliberately data-only: options/import callers receive
// precise reasons without acquiring executable RegExp objects or populating
// the runtime cache. Runtime consumers go through compiledRuleList below.
const validateRuleList = (value, options = {}) => {
  const validation = validateAndCompileRuleList(value, options);
  return {
    ...validation,
    accepted: validation.accepted.map(publicRule)
  };
};

const cacheKey = (value, format) => {
  if (!Array.isArray(value)) {
    return `${RULE_VALIDATION_REVISION}:${format}:not-array:${typeof value}`;
  }
  const bounded = value.slice(0, RULE_LIMITS.rules + 1).map(rule => typeof rule === 'string' ?
    `${rule.length}:${rule.slice(0, RULE_LIMITS.patternLength + 33)}` : typeof rule);
  return `${RULE_VALIDATION_REVISION}:${format}:${value.length}:${bounded.join('\u0000')}`;
};

const compiledRuleList = (value, options = {}) => {
  const format = options.format || 'standard';
  const key = cacheKey(value, format);
  if (cache.has(key)) {
    const entry = cache.get(key);
    cache.delete(key);
    cache.set(key, entry);
    cacheStats.hits += 1;
    return entry;
  }

  cacheStats.misses += 1;
  const validation = validateAndCompileRuleList(value, {compile: true, format});
  cacheStats.compilations += validation.accepted.filter(entry => entry.type === 'regexp').length;
  cache.set(key, validation);
  while (cache.size > RULE_LIMITS.cacheEntries) {
    cache.delete(cache.keys().next().value);
  }
  return validation;
};

const inputRejection = reason => ({
  matched: false,
  matchedRule: null,
  reason,
  rejected: [rejection('input-rejected', reason)],
  valid: false
});

const evaluateRuleList = (value, hostname, href, options = {}) => {
  if (typeof hostname !== 'string' || typeof href !== 'string') {
    return inputRejection('rule input must contain string hostname and URL values');
  }
  if (hostname.length > RULE_LIMITS.inputLength || href.length > RULE_LIMITS.inputLength) {
    return inputRejection(`rule input exceeds ${RULE_LIMITS.inputLength} characters`);
  }
  const validation = compiledRuleList(value, options);
  if (!validation.ok) {
    return {
      matched: false,
      matchedRule: null,
      reason: validation.rejected[0]?.reason || 'rule list was rejected',
      rejected: validation.rejected,
      valid: false
    };
  }
  const format = options.format || 'standard';
  for (const entry of validation.accepted) {
    let matched = false;
    if (entry.type === 'regexp') {
      entry.regexp.lastIndex = 0;
      matched = entry.regexp.test(href);
    }
    else if (format === 'trash') {
      matched = hostname.includes(entry.expression);
    }
    else {
      matched = entry.expression === hostname;
    }
    if (matched) {
      return {
        matched: true,
        matchedRule: entry,
        reason: null,
        rejected: [],
        valid: true
      };
    }
  }
  return {
    matched: false,
    matchedRule: null,
    reason: null,
    rejected: [],
    valid: true
  };
};

const clearRuleCache = () => {
  cache.clear();
  cacheStats.compilations = 0;
  cacheStats.hits = 0;
  cacheStats.misses = 0;
};

const ruleCacheStats = () => ({
  ...cacheStats,
  size: cache.size
});

export {
  clearRuleCache,
  evaluateRuleList,
  REJECTED_RULE_MATCH,
  RULE_LIMITS,
  RULE_VALIDATION_REVISION,
  ruleCacheStats,
  validateRuleList
};
