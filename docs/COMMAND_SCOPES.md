# Command window scopes

| Context | Policy |
| --- | --- |
| Normal, minimized, maximized, fullscreen | Allowed; the selected window ID is the immutable anchor. |
| Edge Workspace or workspace-like normal window | Allowed as a normal window; its browser window ID keeps it isolated. |
| Regular versus incognito | Never crossed. Global/other-window commands remain in the selected tab's privacy context. |
| Browser popup, Chrome App, panel, DevTools | Rejected before ownership reads, focus movement, or discard. |
| Hidden/background normal window | Allowed only when the command explicitly includes that normal window. |

Every tab query is constrained to `windowType: "normal"`. Results and in-flight takeover
snapshots are filtered again by privacy context and explicit selected window ID, because
service-worker `currentWindow` can mean the last active window and is not a durable command
scope. Window state does not affect membership. Future browser window types therefore fail
closed until explicitly added to the policy and fixtures.
