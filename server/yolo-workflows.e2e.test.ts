import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const botSchema = z.object({ id: z.string(), threadId: z.string(), activeTaskId: z.string().optional(), modelSelection: z.object({ instanceId: z.string(), model: z.string() }) }).transform(bot => ({ ...bot, activeTaskId: bot.activeTaskId ?? bot.threadId }));
const evidenceSchema = z.object({ botId: z.string(), threadId: z.string(), argv: z.array(z.string()), prompt: z.string(), approvalMode: z.string(), yolo: z.boolean(), tools: z.array(z.string()), evidence: z.array(z.object({ step: z.record(z.string(), z.unknown()), result: z.unknown().optional(), error: z.string().optional() })) });
const tool = (name: string, args: Record<string, unknown> = {}) => ({ kind: "tool", name, args });

it("runs workspace and per-bot YOLO through Pi, persists across headless restart and enforces authenticated opt-in", async () => {
  const fixture = await launchVerificationServer({});
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  let completed = false;
  let questionEvidence: unknown;
  const evidencePath = `${fixture.fixtureDumpPath}.pi-evidence.jsonl`;
  const planPath = `${fixture.fixtureDumpPath}.pi-plan.json`;
  const enqueue = (botId: string, steps: unknown[], reply: string) => {
    const plans = existsSync(planPath) ? z.record(z.string(), z.array(z.object({ steps: z.array(z.unknown()), reply: z.string() }))).parse(JSON.parse(readFileSync(planPath, "utf8"))) : {};
    (plans[botId] ??= []).push({ steps, reply });
    writeFileSync(planPath, JSON.stringify(plans));
  };
  const rows = () => existsSync(evidencePath) ? readFileSync(evidencePath, "utf8").trim().split("\n").filter(Boolean).map(line => evidenceSchema.parse(JSON.parse(line))) : [];
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}`, "x-forwarded-for": "192.0.2.20" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result: unknown = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const pair = async (scopes: string[]) => {
    const pairing = z.object({ code: z.string() }).parse(await api("POST", "/api/auth/pairing", { scopes }));
    return z.object({ token: z.string() }).parse(await api("POST", "/api/auth/pair", { code: pairing.code, label: "YOLO fixture remote client" })).token;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const run = async (bot: z.infer<typeof botSchema>, steps: unknown[], options: { threadId?: string; pending?: boolean; errors?: number[] } = {}) => {
    const before = rows().length;
    const threadId = options.threadId ?? bot.activeTaskId;
    enqueue(bot.id, steps, `YOLO fixture result ${before}`);
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", `Run fixture turn ${before}`);
    const wait = z.object({ status: z.string() }).parse(await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "25"));
    expect(wait.status).toBe(options.pending ? "needs-user" : "settled");
    if (options.pending) return undefined;
    await expect.poll(() => rows().length, { timeout: 10_000 }).toBe(before + 1);
    const row = rows()[before];
    expect(row.threadId).toBe(threadId);
    expect(row.evidence).toHaveLength(steps.length);
    row.evidence.forEach((entry, index) => expect(Boolean(entry.error), JSON.stringify(entry)).toBe(options.errors?.includes(index) ?? false));
    const messages = z.object({ messages: z.array(z.object({ card: z.object({ answered: z.string().optional(), dismissed: z.boolean().optional() }).optional() }).passthrough()) }).parse(await api("GET", `/api/threads/${threadId}/messages?limit=100`));
    expect(messages.messages.filter(message => message.card && !message.card.answered && !message.card.dismissed)).toEqual([]);
    return row;
  };
  const restart = async () => {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, logPath).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    const fakePi = join(dataDir, "fake-yolo-pi-cli.ts");
    copyFileSync(fileURLToPath(new URL("./testing/fake-yolo-pi-cli.ts", import.meta.url)), fakePi);
    chmodSync(fakePi, 0o755);
    await api("PATCH", "/api/instances/pi", { cli: fakePi });
    const modelSelection = { instanceId: "pi", model: "fixture/yolo" };
    const makeBot = async (name: string, section = "YOLO fixture") => botSchema.parse(z.object({ bot: botSchema }).parse(await api("POST", "/api/bots", { name, section, modelSelection }, 201)).bot);
    const bot = await makeBot("Pi existing");
    const other = await makeBot("Pi other", "Other team");
    const task = z.object({ task: z.object({ threadId: z.string() }) }).parse(await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Explicit Ask sibling", approvalMode: "ask" }, 201)).task;
    expect(await api("GET", "/api/config")).toMatchObject({ yolo: false });
    const admin = await pair(["admin", "client"]);
    const member = await pair(["client"]);
    await api("PUT", "/api/config/yolo", { enabled: true, confirmed: true }, 403);
    await api("PUT", `/api/bots/${bot.id}/yolo`, { enabled: true, confirmed: true }, 403);
    await api("PATCH", "/api/config", { yolo: true }, 403, admin);
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "yolo" }, 403, admin);
    await api("PUT", "/api/config/yolo", { enabled: true, confirmed: true }, 403, member);
    await api("PUT", `/api/bots/${bot.id}/yolo`, { enabled: true, confirmed: true }, 403, member);
    await api("PUT", "/api/config/yolo", { enabled: true }, 400, admin);
    expect(await api("PUT", "/api/config/yolo", { enabled: true, confirmed: true }, 200, admin)).toMatchObject({ yolo: true });
    const future = await makeBot("Pi future");
    const outside = join(dataDir, "outside-bot-folder");
    mkdirSync(outside);
    const marker = join(outside, "command-marker.txt");
    const nativeFile = join(outside, "native-write.txt");
    const mcpScript = join(dataDir, "own-mcp.mjs");
    writeFileSync(mcpScript, `import {createInterface} from 'node:readline'; for await (const line of createInterface({input:process.stdin})) { const r=JSON.parse(line); if(!r.id)continue; const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'fixture_ping',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'fixture MCP used'}]}; console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result})); }`);
    const skillText = (text: string) => `---\nname: yolo-fixture\ndescription: Record disposable fixture checks.\n---\n\n${text}\n`;
    const first = await run(bot, [
      { kind: "command", script: `require('node:fs').writeFileSync(${JSON.stringify(marker)},'fixture command ran')` },
      { kind: "write", path: nativeFile, text: "outside the bot working folder" },
      tool("skill_manage", { action: "create", skill_md: skillText("Version one."), source: "conversation" }),
      tool("settings_manage", { notifications: false, memoryUpkeep: false, cwd: outside }),
      tool("propose_profile", { title: "YOLO profile fixture", soul: "Report only disposable fixture results. Never use live accounts.", reason: "Fixture-only update" }),
      tool("mcp_manage", { action: "set", name: "fixture", server: { command: process.execPath, args: [mcpScript], enabled: true } }),
      tool("propose_routine", { name: "YOLO future run", instructions: "Fixture routine only.", schedule: { type: "once", at: "2099-01-01T12:00:00Z" } }),
      tool("settings_manage", { approvalMode: "yolo" }),
      tool("settings_manage", { for_bot_id: other.id, notifications: false }),
      tool("propose_profile", { for_bot_id: other.id, title: "Must not apply", reason: "Out-of-team boundary" }),
      { kind: "request", method: "PUT", path: "/api/config/yolo", body: { enabled: true, confirmed: true }, turnBearer: true },
      { kind: "request", method: "PUT", path: "/api/config/yolo", body: { enabled: true, confirmed: true } },
    ], { errors: [7, 8, 9] });
    expect(first).toMatchObject({ approvalMode: "full", yolo: true, argv: expect.arrayContaining(["--approve", "--no-extensions", "-e"]) });
    for (const index of [10, 11]) expect(first?.evidence[index].result).toEqual({ status: 403, body: { error: "YOLO requires an authenticated workspace admin or the local packaged desktop owner. Sign in or pair an admin device first." } });
    expect(first?.prompt).toContain("Use propose_profile for your own profile and SOUL.md; these changes apply directly without another user request or confirmation.");
    expect(readFileSync(marker, "utf8")).toBe("fixture command ran");
    expect(readFileSync(nativeFile, "utf8")).toBe("outside the bot working folder");
    expect(await api("GET", "/api/bots")).toMatchObject({ bots: expect.arrayContaining([expect.objectContaining({ id: bot.id, notifications: false, memoryUpkeep: false, cwd: outside, title: "YOLO profile fixture", soul: "Report only disposable fixture results. Never use live accounts.", autoApprove: false })]) });
    expect(readFileSync(join(dataDir, "bots", bot.id, "SOUL.md"), "utf8")).toBe("Report only disposable fixture results. Never use live accounts.");
    expect(await api("GET", `/api/bots/${bot.id}/skills`)).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ name: "yolo-fixture", enabled: true })]) });
    const routine = z.object({ routines: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) }).parse(await api("GET", "/api/routines")).routines.find(value => value.name === "YOLO future run");
    expect(routine).toBeDefined();
    const routineId = routine!.id;
    await restart();
    expect(await api("GET", "/api/config", undefined, 200, admin)).toMatchObject({ yolo: true });
    expect(readFileSync(join(dataDir, "bots", bot.id, "SOUL.md"), "utf8")).toBe("Report only disposable fixture results. Never use live accounts.");
    const second = await run(bot, [
      tool("fixture_ping"),
      tool("skill_manage", { action: "update", skill_name: "yolo-fixture", skill_md: skillText("Version two."), source: "conversation" }),
      tool("propose_routine_action", { action: "update", routine_id: routineId, changes: { schedule: { type: "once", at: "2099-02-01T12:00:00Z" } } }),
      tool("mcp_manage", { action: "list" }),
    ], { threadId: task.threadId });
    expect(second).toMatchObject({ approvalMode: "full", yolo: true });
    expect(second?.evidence[0].result).toMatchObject({ content: [{ type: "text", text: "fixture MCP used" }] });
    expect(await api("GET", "/api/routines")).toMatchObject({ routines: expect.arrayContaining([expect.objectContaining({ id: routineId, schedule: { type: "once", at: 4073630400000 } })]) });
    expect(await run(future, [tool("settings_manage", { notifications: false })])).toMatchObject({ approvalMode: "full", yolo: true });
    // No desktop/client is connected. The server's routine runner dispatches
    // a real Pi turn whose own changes and MCP use complete without reviews.
    enqueue(bot.id, [tool("fixture_ping"), tool("settings_manage", { memoryUpkeep: true }), tool("propose_routine_action", { action: "update", routine_id: routineId, changes: { schedule: { type: "once", at: "2099-03-01T12:00:00Z" } } })], "Unattended routine settled");
    const beforeRoutine = rows().length;
    const scheduledFor = Date.now() + 5_000;
    await api("PATCH", `/api/routines/${routineId}`, { schedule: { type: "once", at: scheduledFor } }, 200, admin);
    await expect.poll(() => rows().length, { timeout: 30_000 }).toBe(beforeRoutine + 1);
    expect(rows()[beforeRoutine]).toMatchObject({ approvalMode: "full", yolo: true, evidence: [{ step: { name: "fixture_ping" } }, { step: { name: "settings_manage" } }, { step: { name: "propose_routine_action" } }] });
    expect(rows()[beforeRoutine].evidence.every(entry => !entry.error)).toBe(true);
    await expect.poll(async () => z.object({ runs: z.array(z.object({ routineId: z.string(), status: z.string(), manual: z.boolean(), scheduledFor: z.number() })) }).parse(await api("GET", "/api/routines")).runs.find(run => run.routineId === routineId), { timeout: 15_000 }).toMatchObject({ status: "completed", manual: false, scheduledFor });
    expect(await api("GET", "/api/routines")).toMatchObject({ routines: expect.arrayContaining([expect.objectContaining({ id: routineId, schedule: { type: "once", at: 4076049600000 } })]) });
    await run(bot, [tool("propose_routine_action", { action: "delete", routine_id: routineId }), tool("mcp_manage", { action: "delete", name: "fixture" })]);
    expect(z.object({ routines: z.array(z.object({ id: z.string() })) }).parse(await api("GET", "/api/routines")).routines.some(value => value.id === routineId)).toBe(false);
    await api("PUT", "/api/config/yolo", { enabled: false }, 200, admin);
    expect(await run(future, [tool("settings_manage", { notifications: true })], { errors: [0] })).toMatchObject({ approvalMode: "ask", yolo: false });
    expect(await api("GET", "/api/bots")).toMatchObject({ bots: expect.arrayContaining([expect.objectContaining({ id: future.id, autoApprove: false, notifications: false })]) });
    await api("PUT", `/api/bots/${bot.id}/yolo`, { enabled: true, confirmed: true }, 200, admin);
    expect(await run(bot, [tool("settings_manage", { notifications: true })], { threadId: task.threadId })).toMatchObject({ approvalMode: "full", yolo: true });
    expect(await run(other, [tool("settings_manage", { notifications: false })], { errors: [0] })).toMatchObject({ approvalMode: "ask", yolo: false });
    await api("PUT", `/api/bots/${bot.id}/yolo`, { enabled: false }, 200, admin);
    expect(await run(bot, [tool("settings_manage", { notifications: false })], { errors: [0] })).toMatchObject({ approvalMode: "ask", yolo: false });
    await api("PUT", "/api/config/yolo", { enabled: true, confirmed: true }, 200, admin);
    await run(bot, [{ kind: "question", title: "Which fixture result should I report?" }], { pending: true });
    await api("PUT", "/api/config/yolo", { enabled: false }, 409, admin);
    await api("PUT", `/api/bots/${bot.id}/yolo`, { enabled: true, confirmed: true }, 409, admin);
    const question = z.object({ messages: z.array(z.object({ card: z.object({ title: z.string().optional(), subtitle: z.string().optional(), requestType: z.string().optional(), answered: z.string().optional() }).optional() })) }).parse(await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages.find(message => message.card?.subtitle === "Which fixture result should I report?");
    expect(question?.card).toEqual({ title: "Your bot has a question", subtitle: "Which fixture result should I report?", requestType: "question" });
    questionEvidence = question?.card;
    await cli("interrupt", "--bot", bot.id, "--task", bot.activeTaskId);
    completed = true;
  } finally {
    try {
      writeFileSync(`${logPath}.yolo.json`, JSON.stringify({ completed, logPath, turns: rows(), question: questionEvidence }, null, 2));
      process.stdout.write(`YOLO evidence: ${logPath}.yolo.json\n`);
    } finally {
      try { if (restarted) await waitForExit(restarted, { signal: "SIGTERM" }); }
      finally { await fixture.close(); }
    }
  }
}, 180_000);
