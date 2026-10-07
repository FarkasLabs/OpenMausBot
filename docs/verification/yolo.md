# Verify YOLO permissions

Run the isolated server and Pi workflow regression:

```sh
pnpm exec vitest run server/yolo-workflows.e2e.test.ts
pnpm exec vitest run server/yolo-authorization.test.ts server/bot-yolo-tools.test.ts
pnpm exec vitest run src/components/WorkspaceYoloSettings.test.ts src/components/ApprovalModeSelector.test.ts
pnpm exec vitest run server/approval-mode.test.ts server/auto-approve.test.ts server/drivers/pi.test.ts server/drivers/pi-mcp-extension.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

The workflow test launches `launchVerificationServer` with a temporary home,
uses `control-omb` for pinned sends and waits, and calls the real authenticated
HTTP configuration endpoints. Its scripted Pi RPC process loads the actual
OpenMausBot MCP extension and invokes real injected agents tools. Native commands
and file writes affect only the fixture's temporary home. No installed bots,
live accounts, or production data are used.

## Assertions

The regression checks these observable results:

- Workspace YOLO requires a confirmed admin session. Anonymous loopback,
  chat-only sessions, live bot-turn bearers, and generic configuration patches
  cannot enable it.
- Existing and future Pi bots, including an explicit Ask sibling thread, run
  with native Full semantics while workspace YOLO is enabled.
- Safe native commands and writes outside the bot's working folder complete.
- `skill_manage` creates and updates an enabled skill without a pending review.
- `propose_profile` updates the bot's profile and SOUL record and mirror. The
  updated SOUL file survives the server restart.
- `settings_manage` applies own settings but refuses approval fields and a
  target identifying another bot.
- `mcp_manage` persists an enabled own-bot server. Its tool executes through
  Pi's real MCP extension after restart. Deleting the definition removes it.
- The scheduler starts a due routine without an open client. It uses MCP,
  updates its own settings, and reschedules its next run. Its receipt is
  `manual: false` and reaches `completed`.
- Routine deletion takes effect without another approval.
- An out-of-team profile change is refused despite YOLO.
- Disabling workspace YOLO restores implicit Ask without rewriting saved
  bot defaults. Per-bot YOLO remains compatible and does not enable it for
  other bots. Disabling that per-bot grant restores Ask.
- A genuine Pi question remains an unanswered question card. Workspace and
  per-bot changes return HTTP 409 while that turn is waiting.
- Pi receives `--approve`, `--no-extensions`, and OpenMausBot's explicit `-e`
  extension path for YOLO turns.

The test always retains `<server-log>.yolo.json` beside the fixture's server log,
including on failure. `completed: true` means every assertion passed. The file
contains bounded fixture prompts, safe tool results, and provider dispatch
facts. It does not contain a session token or the injected turn bearer.
Temporary server data is removed only after its owned processes stop.

## UI checks and limits

The component test mounts the actual workspace setting and warning. It checks
Cancel as the default focus, cancellation without a save, the confirmed PUT,
server-acknowledged switch state, role refusal, and error state without a local
permission change.

For a visual check, launch an isolated fixture as described in the
[verification guide](README.md), then point a separate Vite renderer at its
printed port using `OMB_PORT`. Pair an admin browser with that fixture. Check
**Settings → General → Workspace YOLO**, cancel the warning once, enable the
setting, reload, and disable it. Repeat at a mobile viewport. Use only the
fixture's printed address. Stop the owned Vite and fixture processes afterward.

The scripted provider proves application and transport behavior, not real-model
planning quality or live provider authentication. The component test is not a
native iOS or Android application test. Native apps that lack this control can
use the server's responsive web settings from an authenticated admin browser.
YOLO does not add operating-system isolation to the existing deployment model.
