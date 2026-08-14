# External discard control

External control is disabled by default. A caller is trusted only when its exact
extension ID appears in the `external.trusted-ids` managed-storage policy. When
no managed value exists, a locally paired development installation may use the
same key in `chrome.storage.local`. An existing managed value is authoritative,
including an empty array.

The only accepted message shape is:

```json
{"method":"discard","tabIds":[123,456]}
```

`tabIds` must contain 1–25 unique nonnegative integer tab IDs. Extra keys are
rejected. In particular, callers cannot provide a tab query, URL pattern,
window selector, function, release command, or forced/protection-bypass mode.

Accepted batches use the extension's live inactive-normal-window scope and the
same protection, metadata, ownership, and takeover pipeline as its normal UI.
Incognito, active, missing, out-of-scope, or protected tabs are not mutated.
Only one external batch runs at a time; each sender may start four batches per
ten-second window.

The response has one record, in request order, for every declared ID:

```json
{
  "ok": true,
  "outcomes": [
    {"tabId":123,"status":"succeeded","code":"DISCARDED"},
    {"tabId":456,"status":"skipped","code":"PROTECTED"}
  ],
  "summary":{"failed":0,"skipped":1,"succeeded":1,"total":2}
}
```

Responses never include tab URLs, titles, preference values, ownership records,
or browser exception text. Unknown senders receive `UNAUTHORIZED`; malformed,
busy, and rate-limited requests fail before any tab operation begins.
