import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotMcpStore, yoloSettingsSchema } from "./bot-yolo-tools.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-yolo-mcp-"));
  dirs.push(dir);
  return { dir, store: new BotMcpStore(dir) };
};
const allow = () => undefined;

describe("own YOLO settings and MCP", () => {
  it("accepts own settings but rejects approval, credentials and target identities", () => {
    expect(yoloSettingsSchema.parse({ notifications: false, cwd: "/outside-the-bot-folder" })).toEqual({ notifications: false, cwd: "/outside-the-bot-folder" });
    for (const input of [{ approvalMode: "yolo" }, { yolo: true }, { for_bot_id: "other" }, { owner: "other" }, { apiKey: "fixture" }, { section: "other" }]) {
      expect(yoloSettingsSchema.safeParse(input).success).toBe(false);
    }
  });

  it("persists one bot's servers without exposing credentials or another bot's definitions", () => {
    const { dir, store } = setup();
    const saved = store.mutate("bot-one", { action: "set", name: "fixture", server: { command: "node", args: ["fixture.mjs"], env: { FIXTURE_SECRET: "fixture-secret-value" }, enabled: true } }, allow);
    expect(saved).toMatchObject({ applied: true, servers: [{ name: "fixture", enabled: true }] });
    expect(JSON.stringify(saved)).not.toContain("fixture-secret-value");
    expect(store.mutate("bot-two", { action: "list" }, allow)).toEqual({ servers: [] });
    expect(store.enabled("bot-two")).toEqual({});
    const reloaded = new BotMcpStore(dir);
    expect(reloaded.enabled("bot-one")).toMatchObject({ "own_bot-one_fixture": { env: { FIXTURE_SECRET: "fixture-secret-value" }, enabled: true } });
    if (process.platform !== "win32") expect(statSync(join(dir, "bot-one", "mcp.json")).mode & 0o777).toBe(0o600);
    reloaded.mutate("bot-one", { action: "delete", name: "fixture" }, allow);
    expect(new BotMcpStore(dir).enabled("bot-one")).toEqual({});
  });

  it("refuses OAuth grants, other principals, policy violations and path traversal", () => {
    const { store } = setup();
    expect(() => store.mutate("bot-one", { action: "set", name: "fixture", server: { url: "https://fixture.invalid/mcp", enabled: true, oauth: { clientId: "fixture" } } }, allow)).toThrow("Account sign-in must be configured by the owner");
    expect(() => store.mutate("bot-one", { action: "list", for_bot_id: "bot-two" }, allow)).toThrow();
    expect(() => store.mutate("bot-one", { action: "set", name: "fixture", server: { command: "node", enabled: true } }, () => "Fixture policy refusal")).toThrow("Fixture policy refusal");
    expect(() => store.read("../bot-two")).toThrow("Invalid bot id");
    expect(() => store.mutate("bot-one", { action: "delete", name: "other" }, allow)).toThrow("No own MCP server");
  });
});
