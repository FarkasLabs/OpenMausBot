# Enable YOLO for a workspace

YOLO removes action approval prompts, including destructive commands and file
changes outside a bot's working folder. Enable it only for bots you trust.
Questions, account sign-in, selected tools, team access, computer-sharing grants,
and operating-system permissions still apply.

## Confirm your workspace role

YOLO uses the existing workspace owner and admin permissions. Bots are workspace
assets, not assets with separate per-user owners. Advanced display mode changes
which controls you see. It does not give you an admin role.

For a self-hosted server:

1. On the server, run `openmausbot pair --label "YOLO settings"`.
2. Open the resulting link from the client you want to use. Do not add `--client`,
   which creates chat-only access.
3. Finish pairing with the server.
4. From that client's browser console, confirm the session without printing a
   credential:

```js
fetch("/api/auth/session")
	.then(response => response.json())
	.then(({ kind, scopes }) => ({ kind, scopes }));
```

Expect `kind: "session"` and a `scopes` array that includes `"admin"`. An email
sign-in listed as an admin in the server's existing sign-in configuration also
has that authority. A paired chat-only device does not.

A packaged local desktop owner can use the desktop's private mutation capability
without pairing. A standalone browser's anonymous loopback access is not enough
to enable YOLO. For a headless server, use an authenticated client at the server's
public or tailnet address. See [self-hosted pairing](self-hosting.md).

## Enable the workspace setting

Stop active turns first. An approval change cannot recall a command that has
already started.

1. Open **Settings → General → Workspace YOLO** in the server's web UI. The same
   responsive page works in a mobile browser.
2. In a desktop app connected to a remote server, open **Settings → Appearance →
   Workspace YOLO**. The setting is also available in an existing bot's
   **Permissions** settings.
3. Turn on **Workspace YOLO**.
4. Read the warning, then select **Enable YOLO**.
5. Confirm that the switch stays on after the server acknowledges the change.

Every existing and future bot and thread uses the setting, including unattended
routines and delegated work. No connected desktop or open client is required at
execution time. The server saves the setting in its `config.json` and restores it
after restart. Every bot and thread must use an engine with a YOLO mapping.
Unsupported engines are refused rather than silently granted unrestricted access.

Once enabled, bots can use `propose_profile` to update their own profile and
canonical SOUL instructions without another approval. The tool updates the saved
record and its `bots/<bot-id>/SOUL.md` mirror. Use that tool rather than editing
the mirror directly, which the app treats as an out-of-band edit.

Bots can also manage their own skills, routines, and a bounded set of settings
without approvals. `settings_manage` accepts notification, voice, memory,
browser, and working-folder settings. `mcp_manage` lists, sets, enables, and
deletes the requesting bot's own MCP definitions. Enabled definitions mount on
the next turn. Those tools cannot change workspace authentication, credentials,
YOLO authority, or another bot's configuration. MCP account sign-in remains a
user action. Supplied MCP secrets are write-only in tool results.

## Disable YOLO

1. Stop active turns.
2. Turn off **Workspace YOLO**.
3. Confirm that the switch stays off after the server acknowledges the change.

The server restores each bot and thread's saved approval settings without
rewriting them. A bot with separately enabled per-bot YOLO still uses YOLO.
To disable that grant, choose **Ask for approval** in that bot's permissions.
Per-bot YOLO applies to all of that bot's existing and future threads. Disabling
it resets those threads to Ask.

## Use Pi with YOLO

Select Pi for your bot, then enable the workspace or per-bot setting. OpenMausBot
passes native Full semantics to its MCP extension and runs Pi with `--approve`
and `--no-extensions`. Pi still loads OpenMausBot's explicit MCP extension.
Automatic discovery of user and project extensions is disabled for YOLO turns,
so an external permission extension cannot add another action-approval dialog.
Normal turns retain their existing extension behavior.

YOLO is an application approval policy, not a sandbox or a new account-security
system. A process with unrestricted access to the server's files or an admin
session remains trusted by the existing deployment model. On a shared headless
server, use the existing `OMB_LOOPBACK_TRUST=service` setting and keep admin
session credentials outside bot-accessible files. See
[shared-workspace trust](verification/shared-workspace-trust.md).

For contributor checks and their limits, use the
[isolated YOLO verification recipe](verification/yolo.md).
