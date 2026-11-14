#!/usr/bin/env node
import {
  log
} from "./chunk-PBXVFMOZ.js";

// src/http.ts
import { createServer as createHttpServer } from "http";
import { randomUUID, timingSafeEqual, randomBytes } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
var TOKEN_PATH = path.join(os.homedir(), ".config", "opencode-mcp", "http-token");
async function resolveToken() {
  if (process.env.OPENCODE_MCP_TOKEN) return process.env.OPENCODE_MCP_TOKEN;
  try {
    const existing = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
    if (existing) return existing;
  } catch {
  }
  const token = randomBytes(32).toString("base64url");
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true, mode: 448 });
  await fs.writeFile(TOKEN_PATH, token + "\n", { mode: 384 });
  log.warn(`Generated a bridge token at ${TOKEN_PATH}`);
  return token;
}
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
async function startHttpServer(factory, options) {
  const token = await resolveToken();
  const transports = /* @__PURE__ */ new Map();
  const http = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/configure") {
        if (!authorized(req, token)) {
          res.writeHead(401, { "www-authenticate": 'Bearer realm="opencode-mcp"' });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (req.method === "POST" && options.configure) {
          const body2 = await readJsonBody(req);
          const state = await options.configure(body2 ?? {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(state));
          return;
        }
        if (req.method === "DELETE" && options.clearConfig) {
          const state = await options.clearConfig({});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(state));
          return;
        }
        res.writeHead(405).end();
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end("Not found");
        return;
      }
      if (!authorized(req, token)) {
        res.writeHead(401, { "www-authenticate": 'Bearer realm="opencode-mcp"' });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        res.writeHead(405).end();
        return;
      }
      const sessionID = headerValue(req.headers["mcp-session-id"]);
      let transport = sessionID ? transports.get(sessionID) : void 0;
      if (!transport) {
        if (req.method !== "POST") {
          res.writeHead(400).end(JSON.stringify({ error: "missing mcp-session-id" }));
          return;
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, created);
            log.info(`HTTP session ${id} opened`);
          }
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        const server = factory();
        await server.connect(created);
        transport = created;
      }
      const body = req.method === "POST" ? await readJsonBody(req) : void 0;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      log.error("HTTP request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: "internal_error" }));
    }
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => resolve());
  });
}
function authorized(req, token) {
  const header = headerValue(req.headers.authorization);
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return safeEqual(match[1] ?? "", token);
}
function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.byteLength;
    if (size > 25 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return void 0;
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : void 0;
}
export {
  startHttpServer
};
//# sourceMappingURL=http-RJPWHU4R.js.map