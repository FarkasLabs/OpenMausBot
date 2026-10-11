#!/usr/bin/env node
// Scripted Pi RPC and real OpenMausBot MCP extension in an isolated home.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type extension from "../drivers/pi-mcp-extension.ts";

if (process.argv.includes("--version")) {
  process.stdout.write("pi 0.84.2 (YOLO fixture)\n");
  process.exit(0);
}
type Step = { kind: "tool"; name: string; args: Record<string, unknown> } |
  { kind: "command"; script: string } | { kind: "write"; path: string; text: string } |
  { kind: "question"; title: string } | { kind: "request"; method: string; path: string; body?: unknown; turnBearer?: boolean };
interface Plan { steps: Step[]; reply: string }
interface McpConfig { approvalMode?: string; mcpServers?: Record<string, { env?: Record<string, string> }> }
// These files are written by the owning test and driver, not model input.
const config: McpConfig | undefined = process.env.OMB_MCP_CONFIG ? JSON.parse(readFileSync(process.env.OMB_MCP_CONFIG, "utf8")) : undefined;
const agents = config?.mcpServers?.agents?.env;
const botId = agents?.OMB_BOT_ID ?? "catalog";
const threadId = agents?.OMB_THREAD_ID ?? "catalog";
const dump = process.env.FAKE_CLAUDE_DUMP;
const planPath = dump ? `${dump}.pi-plan.json` : undefined;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
type Api = Parameters<typeof extension>[0];
type Tool = Parameters<Api["registerTool"]>[0];
const tools = new Map<string, Tool>();
const handlers = new Map<string, Array<Parameters<Api["on"]>[1]>>();
const shutdown = () => { for (const handler of handlers.get("session_shutdown") ?? []) handler(); };
const answers = new Map<string, (frame: Record<string, unknown>) => void>();
let active: string[] = ["read", "write", "edit", "bash"];
let sequence = 0;
const ask = (method: "confirm" | "input", title: string, message?: string) => new Promise<Record<string, unknown>>(resolveAnswer => {
  const id = `fixture-${++sequence}`;
  answers.set(id, resolveAnswer);
  send({ type: "extension_ui_request", id, method, title, message });
});
const extensionIndex = process.argv.indexOf("-e");
if (extensionIndex >= 0) {
  // Like real Pi, load only the absolute extension path the caller supplies.
  const loaded: { default: typeof extension } = await import(pathToFileURL(process.argv[extensionIndex + 1]).href);
  await loaded.default({
    registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
    on(event, handler) { const entries = handlers.get(event) ?? []; entries.push(handler); handlers.set(event, entries); },
    getActiveTools: () => active,
    setActiveTools: names => { active = names; },
  });
  for (const handler of handlers.get("session_start") ?? []) handler();
}
const lines = createInterface({ input: process.stdin });
lines.on("close", shutdown);
lines.on("line", raw => {
  const frame: Record<string, unknown> = JSON.parse(raw);
  if (typeof frame.type !== "string") return;
  if (frame.type === "extension_ui_response" && typeof frame.id === "string") {
    answers.get(frame.id)?.(frame);
    answers.delete(frame.id);
    return;
  }
  if (frame.type === "abort") { shutdown(); process.exit(0); }
  if (frame.type === "negotiate_protocol") return;
  const data = frame.type === "get_available_models" ? { models: [{ provider: "fixture", id: "yolo", name: "Fixture Pi" }] }
    : frame.type === "new_session" ? { sessionFile: join(process.env.HOME!, `pi-${botId}.jsonl`) } : {};
  send({ type: "response", id: frame.id, command: frame.type, success: true, data });
  if (frame.type !== "prompt") return;
  void (async () => {
    const plans: Record<string, Plan[]> = planPath ? JSON.parse(readFileSync(planPath, "utf8")) : {};
    const plan = plans[botId]?.shift() ?? { steps: [], reply: "Fixture Pi settled" };
    if (planPath) writeFileSync(planPath, JSON.stringify(plans));
    const evidence: Array<{ step: Step; result?: unknown; error?: string }> = [];
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    for (const step of plan.steps) {
      const callId = `call-${++sequence}`;
      send({ type: "tool_execution_start", toolCallId: callId, toolName: step.kind === "tool" ? step.name : step.kind, args: step });
      try {
        let result: unknown;
        if (step.kind === "tool") {
          const tool = tools.get(step.name) ?? [...tools.values()].find(value => value.name.endsWith(`_${step.name}`));
          if (!tool || !active.includes(tool.name)) throw new Error(`Tool unavailable: ${step.name}`);
          result = await tool.execute(callId, step.args, undefined, undefined, { ui: { confirm: async (title, message) => (await ask("confirm", title, message)).confirmed === true } });
        } else if (step.kind === "command") {
          if (!active.includes("bash")) throw new Error("Tool selection excludes bash");
          result = execFileSync(process.execPath, ["-e", step.script], { encoding: "utf8" });
        } else if (step.kind === "write") {
          if (!active.includes("write")) throw new Error("Tool selection excludes write");
          const home = resolve(process.env.HOME!);
          const localPath = relative(home, resolve(step.path));
          if (isAbsolute(localPath) || localPath === ".." || localPath.startsWith(`..${sep}`)) throw new Error("Fixture writes must remain in the isolated home");
          writeFileSync(step.path, step.text);
          result = readFileSync(step.path, "utf8");
        } else if (step.kind === "request") {
          const response = await fetch(`${agents!.OMB_HARNESS_URL}${step.path}`, {
            method: step.method, headers: { "content-type": "application/json", ...(step.turnBearer ? { authorization: `Bearer ${agents!.OMB_COMMS_TOKEN}` } : {}) },
            ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
          });
          result = { status: response.status, body: await response.json() };
        } else result = await ask("input", step.title);
        evidence.push({ step, result });
        send({ type: "tool_execution_end", toolCallId: callId, isError: false, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        evidence.push({ step, error: message });
        send({ type: "tool_execution_end", toolCallId: callId, isError: true, result: message });
      }
    }
    if (dump) appendFileSync(`${dump}.pi-evidence.jsonl`, `${JSON.stringify({ botId, threadId, argv: process.argv.slice(2), prompt: frame.message, approvalMode: config?.approvalMode, yolo: agents?.OMB_YOLO_ENABLED === "1", tools: [...tools.keys()], evidence })}\n`);
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: plan.reply } });
    send({ type: "turn_end", message: { stopReason: "end_turn" }, usage: { input: 1, output: 1 } });
    send({ type: "agent_end" });
  })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; lines.close(); });
});
