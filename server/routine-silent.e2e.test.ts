import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { ROUTINE_NO_REPORT } from "../shared/routine-delivery.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

it("takes silent routine tools through scheduled/manual execution, main-thread delivery, notifications and Chief incidents", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let stream: SseRecorder | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200): Promise<any> => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, value });
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const bots = async () => (await api("GET", "/api/bots")).bots as any[];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  try {
    const { bot } = await cli("new-bot", "--name", "Silent monitor");
    const { bot: chief } = await cli("new-bot", "--name", "Monitor Chief");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    await api("PATCH", `/api/bots/${bot.id}`, { notifications: true });
    await api("PUT", "/api/config", { features: { routinesInConversation: true } });
    await api("POST", "/api/routines", { name: "Invalid mode", prompt: "Do not run.", botId: bot.id,
      delivery: "bad", schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() } }, 400);
    const main = bot.activeTaskId;
    const { task: planning } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Unrelated planning" }, 201);
    const proposal = async (tool: string, args: unknown) => {
      writeFileSync(planPath, JSON.stringify({ [bot.id]: {
        expectSystemIncludes: ["You can create silent routines", "do not require the user to know"],
        steps: [{ tool, arguments: args }], reply: "Fixture routine configured.",
      } }));
      await cli("send", "--bot", bot.id, "--task", planning.threadId, "--text", "Monitor changes without no-change messages.");
      await cli("wait", "--bot", bot.id, "--task", planning.threadId, "--timeout", "20");
      const card = (await messages(planning.threadId)).findLast(message => message.card?.routineRequest)?.card;
      expect(card).toMatchObject({ answered: "allow", autoApplied: true });
      return card;
    };
    const card = await proposal("propose_routine", { name: "Silent website check", instructions: "Check fixture data; report only a change.",
      delivery: "conditional", schedule: { type: "interval", everyMinutes: 5 } });
    const routineId = card.routineRequest.resultId;
    expect(card.subtitle).toContain("Silent unless");
    await proposal("propose_routine_action", { action: "update", routine_id: routineId, changes: { delivery: "always" } });
    const updated = await proposal("propose_routine_action", { action: "update", routine_id: routineId, changes: { delivery: "conditional" } });
    expect(updated.routineRequest.undo.before.delivery).toBeUndefined();
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "routines.json"), "utf8")).routines[0].delivery).toBe("conditional");
    const chiefBefore = (await bots()).find(candidate => candidate.id === chief.id);
    stream = await openSse(`${fixture.info.url}/api/events`);
    await stream.until(frame => frame.kind === "hello");
    const setReply = (reply: string) => writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps: [], reply } }));
    const state = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
    const settle = async (id: string, status = "completed") => {
      await expect.poll(async () => (await state(id))?.status, { timeout: 20_000 }).toBe(status);
      const run = await state(id);
      evidence.push(await cli("wait", "--bot", bot.id, "--task", run.threadId, "--timeout", "20"));
      evidence.push(await cli("messages", "--bot", bot.id, "--task", run.threadId, "--limit", "10"));
      return run;
    };
    setReply(ROUTINE_NO_REPORT);
    const { run: manual } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    const silent = [await settle(manual.id)];
    const { routine: scheduled } = await api("POST", "/api/routines", { name: "Scheduled silent check", prompt: "Report only a change.",
      botId: bot.id, delivery: "conditional", schedule: { type: "once", at: Date.now() + 2_000 } }, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === scheduled.id)?.status, { timeout: 20_000 }).toBe("completed");
    const scheduledRun = (await api("GET", "/api/routines")).runs.find((run: any) => run.routineId === scheduled.id);
    silent.push(await settle(scheduledRun.id));
    expect(silent.map(run => run.triggerSource)).toEqual(["manual", "schedule"]);
    for (const run of silent) {
      expect(run).toMatchObject({ delivery: "conditional", reportOutcome: "no-report", status: "completed", resultsThreadId: main });
      expect(run.threadId).not.toBe(main);
      expect((await messages(main)).some(message => message.routineRun?.runId === run.id)).toBe(false);
    }
    const savedBot = (await bots()).find(candidate => candidate.id === bot.id);
    expect(savedBot.threadId).toBe(planning.threadId);
    expect(savedBot.tasks.find((task: any) => task.threadId === main).unread).toBeFalsy();
    for (const run of silent) expect(savedBot.tasks.find((task: any) => task.threadId === run.threadId))
      .toMatchObject({ routineRunId: run.id, unread: false, autoApprove: false, approvalMode: "ask" });
    expect((await messages(planning.threadId)).some(message => message.kind === "routine.run")).toBe(false);
    expect((await bots()).find(candidate => candidate.id === chief.id).tasks).toEqual(chiefBefore.tasks);
    await api("PATCH", `/api/bots/${bot.id}`, { name: "Silence observed" });
    await stream.until(frame => frame.kind === "bot" && frame.bot?.name === "Silence observed");
    expect(stream.frames.filter(frame => frame.kind === "notify" && [bot.id, chief.id].includes(frame.notification?.botId))).toEqual([]);
    expect(stream.frames.filter(frame => frame.kind === "message" && frame.message?.kind === "routine.run")).toEqual([]);

    setReply("The fixture website changed. Its new release is 2.0.");
    const { run: reporting } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    const report = await settle(reporting.id);
    expect(report).toMatchObject({ reportOutcome: "report", resultsThreadId: main });
    const delivered = (await messages(main)).find(message => message.routineRun?.runId === report.id);
    expect(delivered.routineRun.summary).toBe("The fixture website changed. Its new release is 2.0.");
    await stream.until(frame => frame.kind === "notify" && frame.notification?.kind === "done" && frame.notification?.botId === bot.id);
    const notifications = stream.frames.filter(frame => frame.kind === "notify" && frame.notification?.botId === bot.id);
    expect(notifications.map(frame => frame.notification.kind)).toEqual(["done"]);
    expect(notifications[0].notification.threadId).toBe(main);
    expect((await bots()).find(candidate => candidate.id === chief.id).tasks).toEqual(chiefBefore.tasks);

    const wrapper = join(fixture.info.dataDir, "silent-failure.mjs");
    writeFileSync(wrapper, `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_MODE = "exit-early";\nawait import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`, { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    const { run: failing } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    const failed = await settle(failing.id, "failed");
    expect(failed.error).toBeTruthy(); expect(failed.reportOutcome).not.toBe("no-report");
    expect((await messages(main)).find(message => message.routineRun?.runId === failing.id)?.routineRun.status).toBe("failed");
    await stream.until(frame => frame.kind === "notify" && frame.notification?.kind === "routine-failed" && frame.notification?.botId === bot.id);
    await expect.poll(async () => (await bots()).find(candidate => candidate.id === chief.id).tasks.some((task: any) => task.title === "Team incidents"), { timeout: 20_000 }).toBe(true);
    evidence.push({ silent, report, failed, notifications: stream.frames.filter(frame => frame.kind === "notify"), bots: await bots() });
  } finally {
    stream?.close();
    const evidencePath = `${fixture.info.logPath}.silent.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);

it("keeps conditional routine permission requests actionable on their exact hidden execution without granting access", async () => {
  const fixture = await launchVerificationServer();
  let broker: Socket | undefined;
  let stream: SseRecorder | undefined;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, status = 200): Promise<any> => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    expect(response.status, `${method} ${path}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, value });
    return value;
  };
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Silent approval fixture", "--url", fixture.info.url]) as any;
    const gate = join(fixture.info.dataDir, "permission-finish");
    const wrapper = join(fixture.info.dataDir, "permission-slow.mjs");
    writeFileSync(wrapper, `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_MODE = "slow";\nprocess.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};\nawait import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`, { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", `/api/bots/${bot.id}`, { notifications: true });
    const { routine } = await api("POST", "/api/routines", { name: "Silent permission check", prompt: "Check the fixture.", botId: bot.id,
      delivery: "conditional", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() } }, 201);
    stream = await openSse(`${fixture.info.url}/api/events`);
    await stream.until(frame => frame.kind === "hello");
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    const state = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
    await expect.poll(async () => (await state())?.status, { timeout: 20_000 }).toBe("running");
    const execution = (await state()).threadId;
    await expect.poll(() => existsSync(fixture.fixtureDumpPath) && JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID === execution, { timeout: 20_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    broker = connect(dump.mcpConfig.mcpServers.ogb.args.at(-1));
    broker.on("error", () => {});
    await new Promise<void>((resolve, reject) => { broker!.once("connect", resolve); broker!.once("error", reject); });
    broker.write(JSON.stringify({ t: "ask", id: "silent-approval", kind: "permission", tool: "Bash", input: { command: "echo permission-fixture" } }) + "\n");
    await expect.poll(async () => (await state()).status, { timeout: 20_000 }).toBe("waiting");
    const notification = await stream.until(frame => frame.kind === "notify" && frame.notification?.kind === "approval" && frame.notification?.botId === bot.id);
    expect(notification.notification.threadId).toBe(execution);
    const transcript = (await api("GET", `/api/threads/${execution}/messages?limit=100`)).messages;
    const approval = transcript.find((message: any) => message.card && !message.card.answered);
    expect(approval.card.tool).toBe("Bash");
    expect((await api("GET", `/api/threads/${bot.activeTaskId}/messages?limit=100`)).messages.some((message: any) => message.routineRun?.runId === run.id)).toBe(false);
    const current = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(current.tasks.find((task: any) => task.threadId === execution)).toMatchObject({ routineRunId: run.id, approvalMode: "ask", autoApprove: false });
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: execution, requestId: approval.card.requestId, behavior: "deny" });
    await api("POST", `/api/routine-runs/${run.id}/cancel`);
    expect((await state()).status).toBe("cancelled");
    const answered = (await api("GET", `/api/threads/${execution}/messages?limit=100`)).messages.find((message: any) => message.id === approval.id);
    expect(answered.card.answered).toBe("deny");
    evidence.push({ notification, current, approval: answered, final: await state() });
  } finally {
    broker?.destroy(); stream?.close();
    writeFileSync(`${fixture.info.logPath}.silent-approval.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
  }
}, 60_000);
