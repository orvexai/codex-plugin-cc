#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const MID_TURN_METHODS = new Set(["turn/steer"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt" || message?.method === "broker/markDetached";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeTurn = null;
  let disconnectingTurnId = null;
  const detachedThreads = new Set();
  const sockets = new Set();
  const closedSockets = new WeakSet();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      activeTurn = null;
    }
  }

  async function interruptTurn(turn) {
    if (!turn || detachedThreads.has(turn.threadId)) return;
    const key = `${turn.threadId}/${turn.turnId}`;
    if (disconnectingTurnId === key) return;
    disconnectingTurnId = key;
    try {
      await appClient.request("turn/interrupt", turn);
      process.stderr.write(`Interrupted broker turn ${turn.threadId}/${turn.turnId} after owner disconnect.\n`);
    } catch (error) {
      process.stderr.write(`Could not interrupt broker turn ${turn.threadId}/${turn.turnId} after owner disconnect: ${error.message}\n`);
    } finally {
      if (disconnectingTurnId === key) disconnectingTurnId = null;
    }
  }

  async function interruptDisconnectedTurn(socket) {
    if (activeStreamSocket !== socket || !activeTurn) return;
    await interruptTurn(activeTurn);
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/started" && activeStreamSocket === target) {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turn?.id;
      if (threadId && turnId) activeTurn = { threadId, turnId };
    }
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (threadId) detachedThreads.delete(threadId);
      if (!threadId || activeTurn?.threadId === threadId) activeTurn = null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        if (message.method === "broker/markDetached") {
          const threadId = message.params?.threadId;
          if (threadId) {
            detachedThreads.add(threadId);
            process.stderr.write(`Marked broker thread ${threadId} detached.\n`);
          }
          send(socket, { id: message.id, result: {} });
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        const brokerDetached = message.method === "turn/start" && message.params?.brokerDetached === true;
        const forwardedParams = { ...(message.params ?? {}) };
        delete forwardedParams.brokerDetached;
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, forwardedParams);
          send(socket, { id: message.id, result });
          if (isStreaming) {
            if (message.method === "turn/start") {
              const threadId = message.params?.threadId;
              const turnId = result?.turn?.id ?? null;
              if (brokerDetached && threadId) detachedThreads.add(threadId);
              const turn = threadId && turnId ? { threadId, turnId } : null;
              if (closedSockets.has(socket) || socket.destroyed) {
                await interruptTurn(turn);
              } else {
                activeStreamSocket = socket;
                activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
                activeTurn = turn;
              }
            } else {
              activeStreamSocket = socket;
              activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            }
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          // A failed mid-turn request (e.g. turn/steer) must not orphan the
          // turn that this socket is still streaming.
          if (activeStreamSocket === socket && !isStreaming && !MID_TURN_METHODS.has(message.method)) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      closedSockets.add(socket);
      void interruptDisconnectedTurn(socket).finally(() => clearSocketOwnership(socket));
    });

    socket.on("error", () => {
      sockets.delete(socket);
      closedSockets.add(socket);
      void interruptDisconnectedTurn(socket).finally(() => clearSocketOwnership(socket));
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
