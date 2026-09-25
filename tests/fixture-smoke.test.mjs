import "./_isolation.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import net from "node:net";

import { buildEnv, fakeConnections, installFakeCodex, readFakeRpcLog, setFakeCodexOptions, startFakeAppServer } from "./fake-codex-fixture.mjs";
import { isPidAlive, makeCompanionWorkspace, makeTempDir, waitFor } from "./helpers.mjs";

async function server(options = {}, behavior = "review-ok") {
  const binDir = makeTempDir("fixture-smoke-bin-");
  installFakeCodex(binDir, behavior, options);
  const app = startFakeAppServer(binDir, { env: { ...buildEnv(binDir), CODEX_HOME: path.join(binDir, "codex-home") } });
  await app.request("initialize", { capabilities: { experimentalApi: true } }).catch(() => {});
  return { binDir, app };
}

async function newThread(app) {
  const result = await app.request("thread/start", { cwd: process.cwd(), ephemeral: true });
  return result.thread.id;
}

test("scripted interrupt cooperate completes interrupted and ignore leaves request unanswered", async (t) => {
  const one = await server({ turnScript: [{ type: "delay", ms: 300 }, { type: "agentMessage", text: "alive" }] });
  t.after(() => one.app.close());
  const threadId = await newThread(one.app);
  const started = one.app.waitForNotification("turn/started");
  await one.app.request("turn/start", { threadId, input: [{ type: "text", text: "x" }] });
  const params = await started;
  one.app.request("turn/interrupt", { threadId, turnId: params.turn.id });
  assert.equal((await one.app.waitForNotification("turn/completed")).turn.status, "interrupted");

  const two = await server({ interrupt: "ignore", turnScript: [{ type: "delay", ms: 650 }, { type: "agentMessage", text: "continued" }] });
  t.after(() => two.app.close());
  const id = await newThread(two.app);
  const started2 = two.app.waitForNotification("turn/started");
  await two.app.request("turn/start", { threadId: id, input: [] });
  const turn = await started2;
  const interrupted = two.app.request("turn/interrupt", { threadId: id, turnId: turn.turn.id }).then(() => true, () => true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(two.app.notifications.some((n) => n.method === "turn/completed"), false);
  assert.equal(await Promise.race([interrupted, new Promise((resolve) => setTimeout(() => resolve(false), 20))]), false);
});

test("scripted delay and silence control turn completion", async (t) => {
  const { app } = await server({ turnScript: [{ type: "silence" }] }); t.after(() => app.close());
  const id = await newThread(app);
  await app.request("turn/start", { threadId: id, input: [] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(app.notifications.some((n) => n.method === "turn/completed"), false);
});

test("fake app-server ignores SIGTERM when configured", async (t) => {
  const { app } = await server({ ignoreSigterm: true }); t.after(() => app.close());
  const pid = app.child.pid; app.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(isPidAlive(pid), true);
  const exited = new Promise((resolve) => app.child.once("exit", resolve));
  app.child.kill("SIGKILL");
  await exited;
});

test("command chunks, plan, diff, and usage notifications are emitted", async (t) => {
  const { app } = await server({ turnScript: [{ type: "command", command: "echo ok", outputChunks: ["a", "b"] }, { type: "fileChange", changes: [{ path: "new.txt", kind: "add", diff: "fixture file\n" }], writeFiles: true }, { type: "plan", steps: [{ step: "one", status: "completed" }] }, { type: "diff", diff: "+ok" }, { type: "usage", total: 3, input: 1, output: 2 }] }); t.after(() => app.close());
  const cwd = makeTempDir("fixture-write-files-");
  const thread = await app.request("thread/start", { cwd, ephemeral: true }); const id = thread.thread.id; await app.request("turn/start", { threadId: id, input: [] });
  await app.waitForNotification("turn/completed");
  assert.deepEqual(app.notifications.filter((n) => n.method === "item/commandExecution/outputDelta").map((n) => n.params.delta), ["a", "b"]);
  assert.equal(fs.readFileSync(path.join(cwd, "new.txt"), "utf8"), "fixture file\n");
  for (const method of ["turn/plan/updated", "turn/diff/updated", "thread/tokenUsage/updated"]) assert.ok(app.notifications.some((n) => n.method === method));
});

test("model, config, and thread read methods expose options and active status", async (t) => {
  const { app } = await server({ config: { config: { custom_key: true } }, models: [{ id: "test", model: "test", displayName: "Test", isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "low" }], writeRollout: true, turnScript: [{ type: "delay", ms: 100 }] }); t.after(() => app.close());
  assert.equal((await app.request("model/list")).data[0].id, "test");
  assert.equal((await app.request("config/read")).config.custom_key, true);
  const id = await newThread(app); const started = app.waitForNotification("turn/started"); await app.request("turn/start", { threadId: id, input: [] }); await started;
  const during = (await app.request("thread/read", { threadId: id })).thread;
  assert.equal(during.status.type, "active"); assert.ok(fs.existsSync(during.path));
  const reread = (await app.request("thread/read", { threadId: id })).thread;
  assert.equal(reread.path, during.path);
  const rolloutDir = path.dirname(during.path);
  const rolloutCount = fs.readdirSync(rolloutDir).filter((name) => name.endsWith(".jsonl")).length;
  await app.request("thread/list", { cwd: process.cwd() });
  assert.equal(fs.readdirSync(rolloutDir).filter((name) => name.endsWith(".jsonl")).length, rolloutCount);
  await app.waitForNotification("turn/completed");
  assert.equal((await app.request("thread/read", { threadId: id })).thread.status.type, "idle");
  await app.request("thread/unload", { threadId: id });
});

test("rollout files default to the fake bin directory when CODEX_HOME is unset", async (t) => {
  const binDir = makeTempDir("fixture-rollout-home-");
  installFakeCodex(binDir, "review-ok", { writeRollout: true });
  const env = buildEnv(binDir); delete env.CODEX_HOME;
  const app = startFakeAppServer(binDir, { env }); t.after(() => app.close());
  const started = await app.request("thread/start", { cwd: process.cwd(), ephemeral: true });
  const rollout = (await app.request("thread/read", { threadId: started.thread.id })).thread.path;
  assert.equal(rollout.startsWith(path.join(binDir, "codex-home") + path.sep), true);
  assert.equal(fs.existsSync(rollout), true);
});

test("active writer mode rejects resume", async (t) => {
  const { app } = await server({ forceActiveWriter: true }); t.after(() => app.close());
  const id = await newThread(app);
  await assert.rejects(app.request("thread/resume", { threadId: id }), /active writer/i);
});

test("steer-rejected and steer-hang keep their legacy completion after interrupt", async (t) => {
  const rejected = await server({}, "steer-rejected");
  const hanging = await server({}, "steer-hang");
  t.after(() => Promise.all([rejected.app.close(), hanging.app.close()]));
  const rejectedThread = await newThread(rejected.app);
  const hangingThread = await newThread(hanging.app);
  const rejectedStart = await rejected.app.request("turn/start", { threadId: rejectedThread, input: [] });
  const hangingStart = await hanging.app.request("turn/start", { threadId: hangingThread, input: [] });
  await rejected.app.request("turn/interrupt", { threadId: rejectedThread, turnId: rejectedStart.turn.id });
  await hanging.app.request("turn/interrupt", { threadId: hangingThread, turnId: hangingStart.turn.id });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(rejected.app.notifications.some((n) => n.method === "turn/completed"), false);
  assert.equal(hanging.app.notifications.some((n) => n.method === "turn/completed"), false);
  const [rejectedDone, hangingDone] = await Promise.all([
    rejected.app.waitForNotification("turn/completed", () => true, 2200),
    hanging.app.waitForNotification("turn/completed", () => true, 1700)
  ]);
  assert.equal(rejectedDone.turn.status, "completed");
  assert.equal(hangingDone.turn.status, "completed");
});

test("subagent metadata follows the turn response and precedes subagent notifications", async (t) => {
  const { app, binDir } = await server({}, "with-subagent"); t.after(() => app.close());
  const threadId = await newThread(app);
  const started = await app.request("turn/start", { threadId, input: [{ type: "text", text: "challenge this" }] });
  await app.waitForNotification("turn/completed", (params) => params.threadId === threadId);
  const rpc = readFakeRpcLog(binDir, { conn: fakeConnections(binDir)[0], dir: "out" });
  const subagentStarted = rpc.findIndex((entry) => entry.method === "thread/started" && entry.params.thread.id !== threadId);
  const turnStartResponse = rpc.findIndex((entry) => entry.method === "turn/start" && entry.result?.turn?.id === started.turn.id);
  assert.ok(subagentStarted >= 0);
  const subagentThreadId = rpc[subagentStarted].params.thread.id;
  const subagentTurnStarted = rpc.findIndex((entry) => entry.method === "turn/started" && entry.params.threadId === subagentThreadId);
  assert.ok(turnStartResponse >= 0 && turnStartResponse < subagentStarted, "turn/start response must be sent before subagent metadata");
  assert.ok(subagentTurnStarted > subagentStarted, "thread metadata must precede subagent turn notifications");
  assert.ok(rpc[subagentStarted].ts - rpc[turnStartResponse].ts >= 50, "metadata should follow the turn response by a processing window");
  assert.equal(rpc[subagentStarted].params.thread.agentNickname, "design-challenger");
  assert.ok(started.turn.id);
});

test("server initiated request and reply are recorded; connections are distinct", async (t) => {
  const binDir = makeTempDir("fixture-rpc-bin-"); installFakeCodex(binDir, "review-ok", { turnScript: [{ type: "serverRequest", params: { command: "approve?" } }] });
  const first = startFakeAppServer(binDir, { env: buildEnv(binDir) }); const second = startFakeAppServer(binDir, { env: buildEnv(binDir) });
  t.after(() => Promise.all([first.close(), second.close()]));
  const id = await newThread(first); const requestNotice = first.waitForNotification("item/commandExecution/requestApproval");
  await first.request("turn/start", { threadId: id, input: [] });
  await requestNotice;
  const incoming = readFakeRpcLog(binDir, { dir: "in" }).filter((r) => r.id !== null);
  const serverReq = readFakeRpcLog(binDir).find((r) => r.method === "item/commandExecution/requestApproval" && r.dir === "out");
  first.child.stdin.write(JSON.stringify({ id: serverReq.id, result: { decision: "accept" } }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(readFakeRpcLog(binDir).some((r) => r.dir === "out" && r.method === "item/commandExecution/requestApproval"));
  assert.ok(readFakeRpcLog(binDir).some((r) => r.dir === "in" && r.method === "item/commandExecution/requestApproval" && r.id === serverReq.id));
  assert.ok(incoming.length);
  assert.equal(fakeConnections(binDir).length, 2);
  assert.ok(readFakeRpcLog(binDir, { conn: fakeConnections(binDir)[0] }).length > 0);
});

test("occupyBroker holds a streaming turn and another raw client gets broker busy", async (t) => {
  const ws = await makeCompanionWorkspace("review-ok", { fakeOptions: { turnScript: [{ type: "delay", ms: 600 }] } }); t.after(() => ws.close());
  const seeded = ws.companion(["task", "--json", "seed broker"]); assert.equal(seeded.status, 0, seeded.stderr);
  const stateRoot = path.join(ws.home, "plugin-data", "state");
  const brokerFile = path.join(stateRoot, fs.readdirSync(stateRoot)[0], "broker.json");
  const endpoint = JSON.parse(fs.readFileSync(brokerFile, "utf8")).endpoint;
  const holder = await (await import("./fake-codex-fixture.mjs")).occupyBroker(endpoint, { holdMs: 30 });
  try {
    const socket = net.createConnection(endpoint.slice("unix:".length)); socket.setEncoding("utf8");
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const response = await new Promise((resolve, reject) => {
      let buffer = ""; socket.on("data", (chunk) => { buffer += chunk; for (const line of buffer.split("\n")) { if (!line.trim()) continue; try { const message = JSON.parse(line); if (message.id === 1) { resolve(message); socket.destroy(); return; } } catch {} } });
      socket.write(JSON.stringify({ id: 1, method: "thread/list", params: {} }) + "\n");
      setTimeout(() => reject(new Error("timed out waiting for broker-busy response")), 1000);
    });
    assert.equal(response.error.code, -32001);
  } finally { holder.release(); }
});

test("occupyBroker contains post-connect socket errors and settles its pending turn", async (t) => {
  const socketPath = path.join(makeTempDir("fixture-holder-socket-"), "broker.sock");
  const broker = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method === "turn/start") {
          socket.destroy(new Error("forced holder socket reset"));
          continue;
        }
        const result = request.method === "thread/start" ? { thread: { id: "thr_holder" } } : { userAgent: "fixture-holder-test" };
        socket.write(JSON.stringify({ id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => broker.listen(socketPath, resolve).once("error", reject));
  t.after(() => new Promise((resolve) => broker.close(() => { fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }); resolve(); })));

  const { occupyBroker } = await import("./fake-codex-fixture.mjs");
  const holder = await occupyBroker(`unix:${socketPath}`, { holdMs: 20 });
  const settled = await Promise.race([holder.turn.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 300))]);
  assert.equal(settled, true, "post-connect socket errors should settle the in-flight turn request");
  holder.release();
});

test("options file can change between turn starts and legacy task output is stable", async (t) => {
  const binDir = makeTempDir("fixture-options-bin-"); installFakeCodex(binDir); const app = startFakeAppServer(binDir, { env: buildEnv(binDir) }); t.after(() => app.close());
  let id = await newThread(app); await app.request("turn/start", { threadId: id, input: [] }); await app.waitForNotification("turn/completed");
  setFakeCodexOptions(binDir, { turnScript: [{ type: "agentMessage", text: "changed" }] });
  id = await newThread(app); await app.request("turn/start", { threadId: id, input: [] }); await app.waitForNotification("turn/completed", (p) => p.threadId === id);
  assert.ok(app.notifications.some((n) => n.method === "item/completed" && n.params.item.text === "changed"));
  const ws = await makeCompanionWorkspace("review-ok"); t.after(() => ws.close());
  const result = ws.companion(["task", "--json", "hello"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rawOutput, "Handled the requested task.\nTask prompt accepted.");
});

test("RPC records can be filtered to one fake connection", async (t) => {
  const binDir = makeTempDir("fixture-rpc-query-"); installFakeCodex(binDir);
  const a = startFakeAppServer(binDir, { env: buildEnv(binDir) }); const b = startFakeAppServer(binDir, { env: buildEnv(binDir) }); t.after(() => Promise.all([a.close(), b.close()]));
  await a.request("model/list"); await b.request("model/list"); await waitFor(() => fakeConnections(binDir).length === 2, { intervalMs: 10 });
  const conns = fakeConnections(binDir); assert.notEqual(conns[0], conns[1]); assert.ok(readFakeRpcLog(binDir, { conn: conns[0], method: "model/list" }).length);
  assert.ok(readFakeRpcLog(binDir, { conn: conns[0], method: "model/list", dir: "in" }).length, "client request should be inbound");
  assert.ok(readFakeRpcLog(binDir, { conn: conns[0], method: "model/list", dir: "out" }).length, "server response should be outbound");
});
