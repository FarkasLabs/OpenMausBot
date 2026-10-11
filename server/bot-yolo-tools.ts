import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { listMcpServers, MAX_MCP_SERVERS, parseMcpServerMutation, parseStoredMcpServer, type StoredMcpServer } from "./mcp-registry.ts";

export const yoloSettingsSchema = z.object({
  notifications: z.boolean().optional(),
  speakReplies: z.boolean().optional(),
  voiceNotes: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  memoryUpkeep: z.boolean().optional(),
  browser: z.boolean().optional(),
  cwd: z.string().max(4_096).nullable().optional(),
}).strict();

const mcpRequestSchema = z.object({
  action: z.enum(["list", "set", "delete"]),
  name: z.string().optional(),
  server: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Definitions belong to one bot, not the workspace's connection registry. */
export class BotMcpStore {
  private readonly dir: string;

  constructor(dir: string) { this.dir = dir; }

  private path(botId: string): string {
    if (!/^[\w-]{1,128}$/.test(botId)) throw new Error("Invalid bot id");
    return join(this.dir, botId, "mcp.json");
  }

  read(botId: string): Record<string, StoredMcpServer> {
    const path = this.path(botId);
    if (!existsSync(path)) return {};
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const map = z.record(z.string(), z.unknown()).parse(raw);
    const servers: Record<string, StoredMcpServer> = {};
    for (const [name, value] of Object.entries(map)) {
      const parsed = parseStoredMcpServer(name, value);
      if (!parsed.ok) throw new Error(parsed.error);
      servers[name] = parsed.server;
    }
    return servers;
  }

  mutate(botId: string, input: unknown, refusal: (name: string, server: StoredMcpServer) => string | undefined) {
    const request = mcpRequestSchema.parse(input);
    const current = this.read(botId);
    if (request.action === "list") return { servers: listMcpServers(current) };
    if (!request.name) throw new Error("set and delete require a server name");
    if (request.action === "delete") {
      if (!Object.hasOwn(current, request.name)) throw new Error("No own MCP server with that name");
      delete current[request.name];
    } else {
      if (!request.server) throw new Error("set requires a complete server object with command or url");
      // The shared OAuth store authenticates workspace connections, never a
      // bot-created definition. Supplied credentials remain write-only.
      if (request.server.oauth !== undefined) throw new Error("Account sign-in must be configured by the owner in MCP settings. Use only credentials already provided to you.");
      if (typeof request.server.enabled !== "boolean") throw new Error("set requires server.enabled true or false");
      const parsed = parseMcpServerMutation(request.name, request.server, current[request.name]);
      if (!parsed.ok) throw new Error(parsed.error);
      // Workspace registration is deliberately inert. This separate own-bot
      // store has already required a human YOLO grant, so its switch applies.
      parsed.server.enabled = request.server.enabled;
      const denied = refusal(request.name, parsed.server);
      if (denied) throw new Error(denied);
      if (!Object.hasOwn(current, request.name) && Object.keys(current).length >= MAX_MCP_SERVERS) throw new Error(`Use at most ${MAX_MCP_SERVERS} own MCP servers`);
      current[request.name] = parsed.server;
    }
    mkdirSync(dirname(this.path(botId)), { recursive: true });
    writeFileAtomic(this.path(botId), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    return { applied: true, servers: listMcpServers(current), message: "Applied to your own MCP configuration. Enabled servers are available next turn. No additional confirmation is needed." };
  }

  enabled(botId: string): Record<string, StoredMcpServer> {
    return Object.fromEntries(Object.entries(this.read(botId)).filter(([, server]) => server.enabled)
      .map(([name, server]) => [`own_${botId}_${name}`, server]));
  }
}
