import { BotMcpStore, yoloSettingsSchema } from "../bot-yolo-tools.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import type { StoredMcpServer } from "../mcp-registry.ts";
import type { Store } from "../store.ts";
import { PASS, type RouteContext } from "./table.ts";

interface OwnYoloDeps {
  store: Pick<Store, "bot" | "patchBot">;
  mcp: BotMcpStore;
  authorized(botId: string, threadId: string): boolean;
  mcpRefusal(name: string, server: StoredMcpServer): string | undefined;
}

/** Internal routes run only after the live turn capability is checked, not
 * through the public session route table. The principal comes from that
 * capability, never from a body field naming a target. */
export function createOwnYoloRoutes(deps: OwnYoloDeps) {
  return async (ctx: Pick<RouteContext, "res" | "method" | "path" | "json"> & { body(): Promise<unknown> }, principal: { botId: string; threadId: string }) => {
    const { res, method, path, json } = ctx;
    if (method !== "POST" || (path !== "/api/internal/own-settings" && path !== "/api/internal/own-mcp")) return PASS;
    const body = await ctx.body();
    const sender = deps.store.bot(principal.botId);
    if (!sender || !deps.authorized(sender.id, principal.threadId)) return json(res, 403, { error: "Only a bot with human-enabled YOLO may manage its own settings or MCP configuration" });
    if (path === "/api/internal/own-mcp") {
      try { return json(res, 200, deps.mcp.mutate(sender.id, body, deps.mcpRefusal)); }
      catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    const parsed = yoloSettingsSchema.safeParse(body);
    if (!parsed.success) return json(res, 400, { error: "Only notifications, speakReplies, voiceNotes, memoryEnabled, memoryUpkeep, browser and cwd may change. Approval, credentials, owner and team settings are user-only." });
    const { cwd, ...settings } = parsed.data;
    const checked = cwd === undefined ? undefined : validateBotCwd(cwd);
    if (checked && !checked.ok) return json(res, 400, { error: checked.error });
    deps.store.patchBot(sender.id, { ...settings, ...(checked?.ok ? { cwd: checked.cwd ?? undefined } : {}) });
    return json(res, 200, { applied: true, message: "Applied to your own settings. No additional confirmation is needed." });
  };
}
