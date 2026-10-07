import type { ModelSelection } from "../contracts.ts";
import type { BotRecord, Store } from "../store.ts";
import { canConfigureYolo, yoloChangeSchema } from "../yolo-authorization.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface YoloRouteDeps {
  desktopManaged: boolean;
  store: Pick<Store, "bot" | "bots" | "tasks" | "patchBot" | "setAllThreadApprovalMode">;
  enabled(): boolean;
  busy(bot: BotRecord): boolean;
  supports(selection: ModelSelection): boolean;
  sessionLive(id: string): boolean;
  saveWorkspace(enabled: boolean): object;
  wireBot(bot: BotRecord): object;
  announce(bot: BotRecord): void;
}

export function createYoloRoutes(deps: YoloRouteDeps): RouteHandler {
  return async ({ req, res, method, path, auth, json, readBody }) => {
    const workspace = path === "/api/config/yolo";
    const botMatch = path.match(/^\/api\/bots\/([\w-]+)\/yolo$/);
    if (method !== "PUT" || (!workspace && !botMatch)) return PASS;
    if (!canConfigureYolo(auth, deps.desktopManaged)) return json(res, 403, { error: "YOLO requires an authenticated workspace admin or the local packaged desktop owner. Sign in or pair an admin device first." });
    const parsed = yoloChangeSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: parsed.error.message });
    if (auth.kind === "session" && !deps.sessionLive(auth.session.id)) return json(res, 401, { error: "Your session ended. Sign in again before changing YOLO." });
    if (workspace) {
      if (parsed.data.enabled && deps.store.bots.some(bot => [bot.modelSelection, ...deps.store.tasks(bot.id).map(task => task.modelSelection ?? bot.modelSelection)].some(selection => !deps.supports(selection)))) return json(res, 400, { error: "Select YOLO-capable engines for every bot and thread before enabling workspace YOLO" });
      if (parsed.data.enabled !== deps.enabled() && deps.store.bots.some(deps.busy)) return json(res, 409, { error: "Stop active turns before changing workspace YOLO. Already running commands cannot be recalled." });
      return json(res, 200, deps.saveWorkspace(parsed.data.enabled));
    }
    const botId = botMatch![1];
    const bot = deps.store.bot(botId);
    if (!bot) return json(res, 404, { error: "bot not found" });
    if (bot.approvalGrant || deps.busy(bot)) return json(res, 409, { error: "Stop this bot's turns before changing YOLO" });
    if (parsed.data.enabled && [bot.modelSelection, ...deps.store.tasks(botId).map(task => task.modelSelection ?? bot.modelSelection)].some(selection => !deps.supports(selection))) return json(res, 400, { error: "One of this bot's engines does not support YOLO" });
    const mode = parsed.data.enabled ? "yolo" : "ask";
    deps.store.patchBot(botId, { approvalMode: mode, autoApprove: false });
    deps.store.setAllThreadApprovalMode(botId, mode);
    const updated = deps.store.bot(botId)!;
    deps.announce(updated);
    return json(res, 200, { bot: deps.wireBot(updated) });
  };
}
