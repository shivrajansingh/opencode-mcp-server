#!/usr/bin/env node
import {
  log,
  redact,
  registerSecret
} from "./chunk-PBXVFMOZ.js";

// src/index.ts
import path7 from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/client.ts
import { OpenCode } from "@opencode/client";

// src/config.ts
import { promises as fs } from "fs";
import os from "os";
import path from "path";

// src/errors.ts
var BridgeError = class extends Error {
  code;
  hint;
  details;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
  toJSON() {
    return { code: this.code, message: redact(this.message), hint: this.hint ? redact(this.hint) : void 0 };
  }
};
function notConfigured() {
  return new BridgeError(
    "OPENCODE_NOT_CONFIGURED",
    "OpenCode MCP server is not configured yet.",
    {
      hint: "Set OPENCODE_URL (for example http://127.0.0.1:4096) and OPENCODE_PASSWORD in this MCP server's configuration, or call opencode_configure with the same values. Run opencode_status to inspect the current state."
    }
  );
}
function unauthorized() {
  return new BridgeError("OPENCODE_UNAUTHORIZED", "OpenCode rejected the configured password (HTTP 401).", {
    hint: "Check OPENCODE_PASSWORD against the value in ~/.config/opencode/service.json, then retry opencode_configure."
  });
}
function versionUnsupported(version) {
  return new BridgeError("OPENCODE_VERSION_UNSUPPORTED", `OpenCode v${version} is not supported; this bridge requires v2.`, {
    hint: "Upgrade OpenCode (opencode upgrade) so GET /api/info reports a 2.x version."
  });
}
function unreachable(url, cause) {
  return new BridgeError("OPENCODE_UNREACHABLE", `Cannot reach the OpenCode server at ${url}.`, {
    hint: "Start it with `opencode serve` (or the TUI) and confirm the address, then run opencode_status.",
    details: cause instanceof Error ? cause.message : String(cause)
  });
}
function invalidInput(message) {
  return new BridgeError("INVALID_INPUT", message);
}
function fromUnknown(error, fallbackMessage = "OpenCode request failed.") {
  if (error instanceof BridgeError) return error;
  const anyError = error;
  const tag = anyError?._tag ?? "";
  const status = typeof anyError?.status === "number" ? anyError.status : void 0;
  if (status === 401 || /unauthori[sz]ed/i.test(tag)) return unauthorized();
  if (status === 404 || /NotFound/i.test(tag)) {
    return new BridgeError("NOT_FOUND", anyError?.message ?? "Resource not found.");
  }
  if (/Version|Unsupported/i.test(tag)) {
    return new BridgeError("OPENCODE_ERROR", anyError?.message ?? fallbackMessage);
  }
  if (status !== void 0 && status >= 400) {
    return new BridgeError("OPENCODE_ERROR", anyError?.message ?? fallbackMessage, { details: anyError?.body ?? anyError?.data });
  }
  const message = anyError?.message ?? String(error);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message)) {
    return new BridgeError("OPENCODE_UNREACHABLE", message);
  }
  return new BridgeError("OPENCODE_ERROR", message || fallbackMessage);
}
function ok(data) {
  return { content: [{ type: "text", text: stringify(data) }] };
}
function fail(error) {
  const bridgeError = fromUnknown(error);
  const payload = {
    ok: false,
    error: bridgeError.toJSON()
  };
  const hint = bridgeError.hint ? `
${redact(bridgeError.hint)}` : "";
  return {
    isError: true,
    content: [{ type: "text", text: `${redact(bridgeError.message)}${hint}

${stringify(payload)}` }]
  };
}
function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// src/config.ts
var PROFILE_VALUES = ["read-only", "workspace-write", "danger-full-access"];
var USERNAME = "opencode";
var ENV_URL = "OPENCODE_URL";
var ENV_PASSWORD = "OPENCODE_PASSWORD";
var runtime = {};
function configPath() {
  return process.env.OPENCODE_MCP_CONFIG ?? path.join(os.homedir(), ".config", "opencode-mcp", "config.json");
}
function setRuntimeConfig(partial) {
  runtime = { ...runtime, ...partial };
  if (runtime.password) registerSecret(runtime.password);
}
function getRuntimeConfig() {
  return { ...runtime };
}
function replaceRuntimeConfig(next) {
  runtime = { ...next };
  if (runtime.password) registerSecret(runtime.password);
}
function clearRuntimeConfig() {
  runtime = {};
}
function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw invalidInput("The OpenCode server URL is empty.");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalidInput(`"${trimmed}" is not a valid URL. Expected something like http://127.0.0.1:4096.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidInput(`Unsupported protocol "${parsed.protocol}". Use http:// or https://.`);
  }
  if (!parsed.hostname) throw invalidInput("The URL has no hostname.");
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}
function isPrivateHost(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const m = /^172\.(\d{1,3})\./.exec(host);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}
async function readFileConfig() {
  const file = configPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return sanitize(parsed, file);
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") {
      log.warn(`Ignoring unreadable config file at ${file}`, { code });
    }
    return null;
  }
}
function sanitize(input, origin) {
  const out = {};
  if (typeof input.url === "string" && input.url.trim()) out.url = input.url.trim();
  if (typeof input.password === "string" && input.password) out.password = input.password;
  if (typeof input.defaultDirectory === "string" && path.isAbsolute(input.defaultDirectory)) {
    out.defaultDirectory = input.defaultDirectory;
  }
  if (Array.isArray(input.allowedRoots)) {
    out.allowedRoots = input.allowedRoots.filter((root) => typeof root === "string" && path.isAbsolute(root));
  }
  if (input.permissionProfile && PROFILE_VALUES.includes(input.permissionProfile)) {
    out.permissionProfile = input.permissionProfile;
  }
  if (!out.url && input.url) log.warn(`Ignoring invalid url in ${origin}`);
  return out;
}
function fromEnv() {
  const out = {};
  if (process.env[ENV_URL]) out.url = process.env[ENV_URL].trim();
  if (process.env[ENV_PASSWORD]) out.password = process.env[ENV_PASSWORD];
  if (process.env.OPENCODE_MCP_DIRECTORY) out.defaultDirectory = process.env.OPENCODE_MCP_DIRECTORY;
  if (process.env.OPENCODE_MCP_ALLOWED_ROOTS) {
    out.allowedRoots = process.env.OPENCODE_MCP_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean);
  }
  const profile = process.env.OPENCODE_MCP_PERMISSION_PROFILE;
  if (profile && PROFILE_VALUES.includes(profile)) out.permissionProfile = profile;
  return out;
}
async function resolveConfig() {
  const file = await readFileConfig() ?? {};
  const merged = { ...file, ...fromEnv(), ...runtime };
  const password = merged.password;
  if (password) registerSecret(password);
  if (!merged.url || !password) return null;
  let url;
  try {
    url = normalizeUrl(merged.url);
  } catch {
    return null;
  }
  return {
    url,
    password,
    defaultDirectory: merged.defaultDirectory,
    allowedRoots: merged.allowedRoots,
    permissionProfile: merged.permissionProfile ?? "workspace-write"
  };
}
async function describeConfig() {
  const file = await readFileConfig() ?? {};
  const env = fromEnv();
  const url = runtime.url ?? env.url ?? file.url;
  const urlSource = runtime.url ? "runtime" : env.url ? "env" : file.url ? "file" : "none";
  const passwordSource = runtime.password ? "runtime" : env.password ? "env" : file.password ? "file" : "none";
  return {
    url: { value: url, source: urlSource },
    password: { present: passwordSource !== "none", source: passwordSource }
  };
}
async function saveConfigFile(partial) {
  const file = configPath();
  const existing = await readFileConfig() ?? {};
  const next = { ...existing };
  for (const [key, value] of Object.entries(partial)) {
    if (value === void 0) continue;
    next[key] = value;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 448 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 384 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 384).catch(() => void 0);
  log.info(`Configuration written to ${file}`);
}
async function removeConfigFile() {
  await fs.rm(configPath(), { force: true });
}
function authHeader(password) {
  return "Basic " + Buffer.from(`${USERNAME}:${password}`).toString("base64");
}

// src/client.ts
var PROBE_TIMEOUT_MS = 5e3;
var VERSION_RE = /^2\./;
var OpenCodeBridge = class {
  constructor(options) {
    this.options = options;
  }
  options;
  config = null;
  clientInstance = null;
  clientKey = "";
  lastState = { configured: false, connected: false, error: "not_configured" };
  get configuration() {
    return this.config;
  }
  /** Re-read configuration from runtime/env/file and rebuild the client when it changed. */
  async reload() {
    this.config = await resolveConfig();
    if (!this.config) {
      this.clientInstance = null;
      this.clientKey = "";
      this.lastState = { configured: false, connected: false, error: "not_configured" };
      return null;
    }
    const key = `${this.config.url}\0${this.config.password}`;
    if (key !== this.clientKey) {
      this.clientInstance = buildClient(this.config);
      this.clientKey = key;
      this.lastState = { configured: true, connected: false };
    }
    return this.config;
  }
  async client() {
    const config = await this.reload();
    if (!config || !this.clientInstance) throw notConfigured();
    return this.clientInstance;
  }
  async configOrThrow() {
    const config = await this.reload();
    if (!config) throw notConfigured();
    return config;
  }
  async state() {
    return this.lastState;
  }
  /** Full health check: reachability + auth + v2 gate. */
  async probe() {
    const config = await this.reload();
    if (!config) {
      const provenance = await describeConfig();
      this.lastState = {
        configured: false,
        connected: false,
        error: "not_configured",
        url: provenance.url.value,
        message: "OpenCode MCP server is not configured yet.",
        hint: "Set OPENCODE_URL (for example http://127.0.0.1:4096) and OPENCODE_PASSWORD, or call opencode_configure. Run opencode_status for details."
      };
      return this.lastState;
    }
    return this.probeWith(config);
  }
  async probeWith(config) {
    const client = buildClient(config);
    try {
      const info = await client.server.info({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const version = String(info.version ?? "");
      if (!VERSION_RE.test(version)) {
        this.lastState = {
          configured: true,
          connected: false,
          url: config.url,
          version,
          error: "version_unsupported",
          message: `OpenCode v${version || "unknown"} is not supported; v2 is required.`,
          hint: "Run `opencode upgrade` so GET /api/info reports 2.x."
        };
        return this.lastState;
      }
      this.lastState = {
        configured: true,
        connected: true,
        url: config.url,
        version,
        hostname: info.hostname,
        pid: info.pid
      };
      return this.lastState;
    } catch (error) {
      this.lastState = stateFromError(config.url, error);
      return this.lastState;
    }
  }
  /**
   * Validate and apply new credentials. Nothing changes when validation fails.
   * `persist` is opt-in; the default is process-lifetime only.
   */
  async configure(input, options = this.options) {
    const current = await resolveConfig();
    const runtime2 = getRuntimeConfig();
    const url = input.url ?? current?.url ?? runtime2.url;
    const password = input.password ?? current?.password ?? runtime2.password;
    if (!url) throw invalidInput("A server address is required (for example http://127.0.0.1:4096).");
    if (!password) throw invalidInput("A password is required. Find it in ~/.config/opencode/service.json.");
    const normalized = normalizeUrl(url);
    if (!isPrivateHost(normalized) && !options.allowRemoteUrl) {
      throw invalidInput(
        `Refusing remote host ${new URL(normalized).hostname}: only loopback/private addresses are allowed by default. Start the bridge with --allow-remote-url if this is intentional.`
      );
    }
    const candidate = {
      url: normalized,
      password,
      defaultDirectory: current?.defaultDirectory ?? runtime2.defaultDirectory,
      allowedRoots: current?.allowedRoots ?? runtime2.allowedRoots,
      permissionProfile: current?.permissionProfile ?? "workspace-write"
    };
    const state = await this.probeWith(candidate);
    if (!state.connected) {
      const error = stateToError(state);
      throw error;
    }
    if (input.test) {
      return state;
    }
    const previous = getRuntimeConfig();
    replaceRuntimeConfig({ ...previous, url: normalized, password });
    await this.reload();
    if (input.persist) {
      try {
        await saveConfigFile({ url: normalized, password });
      } catch (error) {
        replaceRuntimeConfig(previous);
        await this.reload();
        throw new BridgeError("INTERNAL", `Could not write the config file: ${error.message}`);
      }
    }
    log.info(`Configured OpenCode connection to ${normalized}`);
    return this.probe();
  }
  /** Forget runtime credentials and, optionally, the stored config file. */
  async clear(options = {}) {
    clearRuntimeConfig();
    if (options.includeFile) await removeConfigFile();
    await this.reload();
    return this.probe();
  }
};
function buildClient(config) {
  return OpenCode.make({
    baseUrl: config.url,
    headers: { authorization: authHeader(config.password) }
  });
}
function stateFromError(url, error) {
  const bridgeError = asBridgeError(url, error);
  return {
    configured: true,
    connected: false,
    url,
    error: bridgeError.code === "OPENCODE_UNAUTHORIZED" ? "unauthorized" : bridgeError.code === "OPENCODE_UNREACHABLE" ? "unreachable" : bridgeError.code === "OPENCODE_VERSION_UNSUPPORTED" ? "version_unsupported" : "error",
    message: bridgeError.message,
    hint: bridgeError.hint
  };
}
function asBridgeError(url, error) {
  if (error instanceof BridgeError) return error;
  const anyError = error;
  const tag = anyError?._tag ?? "";
  if (tag === "UnauthorizedError" || anyError?.status === 401) return unauthorized();
  if (tag === "UnsupportedModelError") {
    return new BridgeError("OPENCODE_ERROR", anyError?.message ?? "Unsupported model.");
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|aborted|timeout/i.test(anyError?.message ?? "")) {
    return unreachable(url, error);
  }
  return new BridgeError("OPENCODE_ERROR", anyError?.message ?? String(error));
}
function stateToError(state) {
  const hint = state.hint;
  switch (state.error) {
    case "not_configured":
      return notConfigured();
    case "unauthorized":
      return unauthorized();
    case "version_unsupported":
      return versionUnsupported(state.version ?? "unknown");
    case "unreachable":
      return unreachable(state.url ?? "the configured URL", state.message);
    default:
      return new BridgeError("OPENCODE_ERROR", state.message ?? "OpenCode request failed.", { hint });
  }
}

// src/discovery.ts
import { promises as fs2 } from "fs";
import os2 from "os";
import path2 from "path";
var OPENCODE_SERVICE_PATHS = [
  path2.join(os2.homedir(), ".local", "state", "opencode", "service.json"),
  path2.join(os2.homedir(), ".config", "opencode", "service.json")
];
async function readServiceFile() {
  for (const file of OPENCODE_SERVICE_PATHS) {
    try {
      const raw = await fs2.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed.password) continue;
      const url = parsed.url ?? (parsed.port ? `http://127.0.0.1:${parsed.port}` : void 0);
      if (!url) continue;
      return { url, password: parsed.password };
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT") log.debug(`Could not read ${file}`, { code });
    }
  }
  return null;
}

// src/tools/config.ts
import { z } from "zod";

// src/workspace.ts
import { promises as fs3 } from "fs";
import os3 from "os";
import path3 from "path";
var ENV_HINTS = ["CLAUDE_PROJECT_DIR", "OPENCODE_MCP_DIRECTORY", "INIT_CWD"];
var rootsCache = null;
var ROOTS_TTL_MS = 5e3;
async function readRoots(provider) {
  if (!provider) return [];
  if (rootsCache && Date.now() - rootsCache.at < ROOTS_TTL_MS) return rootsCache.roots;
  try {
    const uris = await provider();
    const roots = uris.map(uriToDirectory).filter((value) => Boolean(value));
    rootsCache = { at: Date.now(), roots };
    return roots;
  } catch (error) {
    log.debug("roots/list unavailable", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
function uriToDirectory(uri) {
  if (!uri.startsWith("file://")) return null;
  try {
    const url = new URL(uri);
    if (url.hostname && url.hostname !== "localhost") return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}
async function isDirectory(candidate) {
  try {
    return (await fs3.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}
function isUselessDirectory(candidate) {
  const resolved = path3.resolve(candidate);
  return resolved === path3.parse(resolved).root || resolved === os3.homedir();
}
async function resolveWorkspace(options = {}) {
  const base = options.config?.defaultDirectory ?? process.cwd();
  if (options.directory) {
    const candidate = path3.isAbsolute(options.directory) ? options.directory : path3.resolve(base, options.directory);
    if (!await isDirectory(candidate)) {
      throw invalidInput(`Workspace directory does not exist: ${candidate}`);
    }
    return { directory: await realpath(candidate), source: "argument" };
  }
  for (const root of await readRoots(options.roots)) {
    if (await isDirectory(root)) return { directory: await realpath(root), source: "roots" };
  }
  for (const name of ENV_HINTS) {
    const value = process.env[name];
    if (value && path3.isAbsolute(value) && await isDirectory(value)) {
      return { directory: await realpath(value), source: "env" };
    }
  }
  if (options.config?.defaultDirectory) {
    if (await isDirectory(options.config.defaultDirectory)) {
      return { directory: await realpath(options.config.defaultDirectory), source: "config" };
    }
    log.warn(`Configured defaultDirectory does not exist: ${options.config.defaultDirectory}`);
  }
  const cwd = process.cwd();
  if (!isUselessDirectory(cwd) && await isDirectory(cwd)) {
    return { directory: await realpath(cwd), source: "cwd" };
  }
  throw new BridgeError("INVALID_INPUT", "Cannot determine which directory to work in.", {
    hint: `Pass \`directory\` (absolute path) to the tool, set OPENCODE_MCP_DIRECTORY, or configure a defaultDirectory. The bridge refuses to fall back to ${cwd} because it is the home or filesystem root.`
  });
}
async function assertWithinAllowedRoots(directory, allowedRoots) {
  if (!allowedRoots || allowedRoots.length === 0) return;
  const target = await realpath(directory);
  for (const root of allowedRoots) {
    const resolvedRoot = await realpath(root);
    const relative = path3.relative(resolvedRoot, target);
    if (relative === "" || !relative.startsWith("..") && !path3.isAbsolute(relative)) return;
  }
  throw new BridgeError("PATH_NOT_ALLOWED", `Directory is outside the allowed roots: ${target}`, {
    hint: `Allowed roots: ${allowedRoots.join(", ")}. Update OPENCODE_MCP_ALLOWED_ROOTS to permit this path.`
  });
}
async function realpath(candidate) {
  try {
    return await fs3.realpath(candidate);
  } catch {
    return path3.resolve(candidate);
  }
}

// src/tools/shared.ts
function register(server, name, definition, handler) {
  const callback = async (args, extra) => {
    try {
      const result = await handler(args ?? {}, extra);
      if (isToolResult(result)) return result;
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  };
  server.registerTool(name, definition, callback);
}
function isToolResult(value) {
  return Boolean(value && typeof value === "object" && "content" in value);
}
async function currentConfig(ctx) {
  return ctx.bridge.configuration ?? await ctx.bridge.reload();
}
async function workspaceFor(ctx, directory) {
  const config = await currentConfig(ctx);
  const workspace = await resolveWorkspace({ directory, config, roots: ctx.rootsProvider });
  await assertWithinAllowedRoots(workspace.directory, config?.allowedRoots);
  return { ...workspace, config };
}
async function openClient(ctx) {
  const config = await ctx.bridge.configOrThrow();
  const client = await ctx.bridge.client();
  return { client, config };
}
function assertWritable(ctx, what) {
  if (ctx.readOnly) {
    throw new BridgeError("INVALID_INPUT", `The bridge is running in read-only mode; ${what} is disabled.`);
  }
}

// src/tools/config.ts
function registerConfigTools(server, ctx) {
  register(
    server,
    "opencode_status",
    {
      title: "OpenCode status",
      description: "Report whether this MCP bridge is configured and connected to an OpenCode v2 server. Works even when nothing is configured, so it is the first tool to call when something looks wrong.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const state = await ctx.bridge.probe();
      const provenance = await describeConfig();
      const out = {
        configured: state.configured,
        connected: state.connected,
        url: state.url ?? provenance.url.value,
        configSource: provenance.url.source,
        passwordPresent: provenance.password.present,
        version: state.version,
        hostname: state.hostname,
        pid: state.pid,
        error: state.error,
        message: state.message,
        hint: state.hint
      };
      if (state.connected) {
        try {
          const workspace = await workspaceFor(ctx);
          out.directory = workspace.directory;
          out.directorySource = workspace.source;
          const client = await ctx.bridge.client();
          const [agents, model] = await Promise.all([
            client.agent.list({ location: { directory: workspace.directory } }).catch(() => null),
            client.model.default({ location: { directory: workspace.directory } }).catch(() => null)
          ]);
          if (agents) out.agents = agents.data.map((agent) => ({ id: agent.id, name: agent.name, mode: agent.mode }));
          if (model?.data) out.defaultModel = { providerID: model.data.providerID, id: model.data.modelID };
        } catch {
        }
      }
      return out;
    }
  );
  register(
    server,
    "opencode_configure",
    {
      title: "Configure OpenCode connection",
      description: "Set or repair the OpenCode v2 server address and password from inside the chat. The values are validated against GET /api/info before they are applied; nothing changes on failure. The password is never echoed back, is kept in memory by default, and is only written to disk when persist=true. Prefer configuring OPENCODE_URL and OPENCODE_PASSWORD in the MCP client settings when possible.",
      inputSchema: {
        url: z.string().optional().describe("OpenCode server address, e.g. http://127.0.0.1:4096"),
        password: z.string().optional().describe("OpenCode Basic-auth password (username is always 'opencode')"),
        persist: z.boolean().optional().describe("Write the values to the 0600 config file (default false)"),
        test: z.boolean().optional().describe("Validate and report, without applying"),
        clear: z.boolean().optional().describe("Forget runtime credentials"),
        removeFile: z.boolean().optional().describe("With clear=true, also delete the stored config file")
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async (args) => {
      if (args.clear) {
        const state2 = await ctx.bridge.clear({ includeFile: Boolean(args.removeFile) });
        return { ok: true, configured: state2.configured, connected: state2.connected, error: state2.error };
      }
      if (!args.url && !args.password) {
        throw invalidInput("Provide url and/or password, or clear=true.");
      }
      const state = await ctx.bridge.configure(
        { url: args.url, password: args.password, persist: Boolean(args.persist), test: Boolean(args.test) },
        { allowRemoteUrl: ctx.allowRemoteUrl }
      );
      return {
        ok: state.connected,
        configured: state.configured,
        connected: state.connected,
        url: state.url,
        version: state.version,
        hostname: state.hostname,
        persisted: Boolean(args.persist) && !args.test,
        tested: Boolean(args.test)
      };
    }
  );
  register(
    server,
    "opencode_workspace",
    {
      title: "Resolve workspace directory",
      description: "Report which directory sessions will use, where that choice came from (argument, MCP roots, env, config, cwd), or persist a new default. Use this before creating a session when you are unsure about the working directory.",
      inputSchema: {
        action: z.enum(["info", "set-default", "list-roots"]).optional().describe("Default: info"),
        directory: z.string().optional().describe("Absolute path (required for set-default)")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      const action = args.action ?? "info";
      if (action === "list-roots") {
        const roots = await ctx.rootsProvider().catch(() => []);
        return { roots };
      }
      if (action === "set-default") {
        if (!args.directory) throw invalidInput("directory is required for set-default");
        const workspace2 = await workspaceFor(ctx, args.directory);
        await saveConfigFile({ defaultDirectory: workspace2.directory });
        return { ok: true, directory: workspace2.directory, persisted: true };
      }
      const workspace = await workspaceFor(ctx, args.directory);
      return {
        directory: workspace.directory,
        source: workspace.source,
        defaultDirectory: workspace.config?.defaultDirectory,
        allowedRoots: workspace.config?.allowedRoots ?? null,
        permissionProfile: workspace.config?.permissionProfile
      };
    }
  );
}

// src/tools/session.ts
import { z as z2 } from "zod";
var modelRef = z2.object({
  providerID: z2.string(),
  id: z2.string(),
  variant: z2.string().optional()
});
var permissionRule = z2.object({
  action: z2.string(),
  resource: z2.string(),
  effect: z2.enum(["allow", "deny", "ask"])
});
function registerSessionTools(server, ctx) {
  register(
    server,
    "opencode_session_create",
    {
      title: "Create OpenCode session",
      description: "Create a new OpenCode session in a directory. Defaults to the client's current workspace. Use agent='build' for implementation work, 'plan' for planning, and 'general'/'explore' for subagents. Pass parentSessionID to create a child (subagent) session.",
      inputSchema: {
        directory: z2.string().optional().describe("Absolute working directory for the session"),
        title: z2.string().optional(),
        agent: z2.string().optional().describe("Agent id, e.g. build, plan, general, explore"),
        model: modelRef.optional().describe("Explicit model, e.g. { providerID: 'opencode', id: 'iceman-free' }"),
        parentSessionID: z2.string().optional().describe("Makes this a subagent session"),
        permissions: z2.array(permissionRule).optional().describe("Per-session permission ruleset")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory);
      const { client } = await openClient(ctx);
      const info = await client.session.create({
        location: { directory: workspace.directory },
        title: args.title,
        agent: args.agent,
        model: args.model,
        parentID: args.parentSessionID,
        permissions: args.permissions
      });
      return {
        sessionID: info.id,
        title: info.title,
        directory: info.location?.directory ?? workspace.directory,
        agent: info.agent,
        model: info.model ?? args.model ?? null,
        parentSessionID: info.parentID ?? null
      };
    }
  );
}
function registerSessionAdminTools(server, ctx) {
  register(
    server,
    "opencode_session_list",
    {
      title: "List OpenCode sessions",
      description: "List sessions, newest first. Filter by directory, search text, archive state, or parent session.",
      inputSchema: {
        directory: z2.string().optional(),
        search: z2.string().optional(),
        archived: z2.boolean().optional(),
        limit: z2.number().int().min(1).max(200).optional(),
        cursor: z2.string().optional(),
        parentSessionID: z2.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory);
      const { client } = await openClient(ctx);
      const response = await client.session.list({
        directory: workspace.directory,
        search: args.search,
        archived: args.archived,
        limit: args.limit ?? 20,
        cursor: args.cursor,
        parentID: args.parentSessionID
      });
      return {
        directory: workspace.directory,
        sessions: response.data.map(summarize),
        cursor: response.cursor ?? null
      };
    }
  );
  register(
    server,
    "opencode_session_get",
    {
      title: "Get OpenCode session",
      description: "Fetch one session's metadata: title, agent, model, cost, tokens, timestamps and outcome.",
      inputSchema: { sessionID: z2.string() },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const { client } = await openClient(ctx);
      const info = await client.session.get({ sessionID: args.sessionID });
      return summarize(info);
    }
  );
  register(
    server,
    "opencode_session_move",
    {
      title: "Move OpenCode session",
      description: "Change the working directory of an existing session.",
      inputSchema: {
        sessionID: z2.string(),
        directory: z2.string().describe("New absolute working directory")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      assertWritable(ctx, "moving a session");
      if (!args.directory) throw invalidInput("directory is required");
      const workspace = await workspaceFor(ctx, args.directory);
      const { client } = await openClient(ctx);
      await client.session.move({ sessionID: args.sessionID, directory: workspace.directory });
      return { ok: true, sessionID: args.sessionID, directory: workspace.directory };
    }
  );
  register(
    server,
    "opencode_session_delete",
    {
      title: "Delete OpenCode session",
      description: "Delete a session and its messages.",
      inputSchema: { sessionID: z2.string() },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    async (args) => {
      assertWritable(ctx, "deleting a session");
      const { client } = await openClient(ctx);
      await client.session.remove({ sessionID: args.sessionID });
      return { ok: true, deleted: args.sessionID };
    }
  );
  register(
    server,
    "opencode_session_interrupt",
    {
      title: "Interrupt OpenCode run",
      description: "Stop the current run in a session. The session stays usable afterwards.",
      inputSchema: { sessionID: z2.string() },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      const { client } = await openClient(ctx);
      const response = await client.session.interrupt({ sessionID: args.sessionID });
      return { ok: true, sessionID: args.sessionID, response };
    }
  );
  register(
    server,
    "opencode_session_compact",
    {
      title: "Compact OpenCode session",
      description: "Summarize older turns to free context. Returns the compaction inbox item and token totals before/after when the service reports them.",
      inputSchema: {
        sessionID: z2.string(),
        wait: z2.boolean().optional().describe("Wait for the compaction to finish (default true)")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      assertWritable(ctx, "compacting a session");
      const { client } = await openClient(ctx);
      const before = await client.session.get({ sessionID: args.sessionID }).catch(() => null);
      const inbox = await client.session.compact({ sessionID: args.sessionID });
      if (args.wait !== false) {
        await client.experimental.session.wait({ sessionID: args.sessionID }).catch(() => void 0);
      }
      const after = await client.session.get({ sessionID: args.sessionID }).catch(() => null);
      return {
        ok: true,
        sessionID: args.sessionID,
        inbox,
        before: before ? { tokens: before.tokens, cost: before.cost } : null,
        after: after ? { tokens: after.tokens, cost: after.cost } : null
      };
    }
  );
}
function summarize(info) {
  return {
    sessionID: info.id,
    title: info.title,
    parentSessionID: info.parentID ?? null,
    directory: info.location?.directory,
    agent: info.agent,
    model: info.model,
    cost: info.cost,
    tokens: info.tokens,
    outcome: info.outcome,
    created: info.time?.created,
    updated: info.time?.updated
  };
}

// src/tools/prompt.ts
import { promises as fs4 } from "fs";
import path4 from "path";
import { z as z3 } from "zod";
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var fileInput = z3.object({
  uri: z3.string().optional().describe("data: URI, file: URI, or absolute path"),
  path: z3.string().optional().describe("Absolute or workspace-relative path to read and attach"),
  name: z3.string().optional(),
  description: z3.string().optional()
});
function registerPromptTools(server, ctx) {
  register(
    server,
    "opencode_session_prompt",
    {
      title: "Prompt an OpenCode session",
      description: "Send a message to a session and (by default) wait for the answer. Returns the assistant text, new turns, tool calls and usage. Attach files with `files` (path or data: URI). Set wait=false for fire-and-forget.",
      inputSchema: {
        sessionID: z3.string(),
        text: z3.string().describe("The prompt text"),
        files: z3.array(fileInput).optional(),
        agents: z3.array(z3.object({ name: z3.string() })).optional().describe("Agents the model may delegate to"),
        skills: z3.array(z3.object({ id: z3.string() })).optional(),
        wait: z3.boolean().optional().describe("Wait for the run to finish (default true)"),
        timeoutMs: z3.number().int().min(1e3).max(36e5).optional().describe("Default 45000 (kept under typical MCP client timeouts)")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => executePrompt(ctx, args)
  );
}
async function executePrompt(ctx, input) {
  assertWritable(ctx, "sending prompts");
  if (!input.text?.trim() && !(input.files?.length ?? 0)) {
    throw invalidInput("Provide text and/or at least one file.");
  }
  const { client } = await openClient(ctx);
  const session = await client.session.get({ sessionID: input.sessionID });
  const directory = session.location?.directory ?? (await workspaceFor(ctx)).directory;
  const files = await Promise.all((input.files ?? []).map((file) => toAttachment(directory, file)));
  const startedAt = Date.now();
  await client.session.prompt({
    sessionID: input.sessionID,
    text: input.text ?? "",
    files,
    agents: input.agents,
    skills: input.skills
  });
  const shouldWait = input.wait !== false;
  const status = shouldWait ? await waitForIdle(client, input.sessionID, input.timeoutMs ?? 45e3) : "running";
  const messages = await collectMessages(client, input.sessionID, startedAt);
  const text = assistantText(messages);
  const tools = toolCalls(messages);
  const usage = usageFrom(messages);
  const resolvedStatus = status === "idle" && messages.length === 0 ? "empty" : status;
  return {
    sessionID: input.sessionID,
    status: resolvedStatus,
    directory,
    text,
    messages: messages.map(renderMessage),
    tools,
    usage,
    attachments: files.map((file) => ({ name: file.name, uri: previewUri(file.uri) })),
    hint: resolvedStatus === "idle" ? void 0 : resolvedStatus === "empty" ? "The provider returned no messages. The prompt may not have been delivered; retry, or inspect the session in the OpenCode TUI." : "The run is still in progress. Poll opencode_session_history until it is idle, or call opencode_session_interrupt to stop it."
  };
}
async function waitForIdle(client, sessionID, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await client.experimental.session.wait({ sessionID }, { signal: controller.signal });
    return "idle";
  } catch (error) {
    if (controller.signal.aborted) return "timeout";
    const message = error?.message ?? "";
    if (/abort/i.test(message)) return "timeout";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function collectMessages(client, sessionID, since) {
  const response = await client.message.list({ sessionID, limit: 100, order: "desc" });
  const recent = response.data.filter((message) => (message.time?.created ?? 0) >= since - 1e3);
  return recent.reverse();
}
function assistantText(messages) {
  return messages.filter((message) => message.type === "assistant").flatMap((message) => (message.content ?? []).filter((part) => part.type === "text")).map((part) => part.text ?? "").join("\n\n").trim();
}
function toolCalls(messages) {
  const out = [];
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue;
      out.push({ name: part.name ?? part.tool ?? "tool", status: part.state?.status ?? "unknown", input: part.state?.input });
    }
  }
  return out;
}
function usageFrom(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "assistant" && (message.cost !== void 0 || message.tokens)) {
      return { cost: message.cost, tokens: message.tokens };
    }
  }
  return null;
}
function renderMessage(message) {
  switch (message.type) {
    case "user":
      return { type: "user", text: message.text, at: message.time?.created };
    case "assistant": {
      const text = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const tools = (message.content ?? []).filter((part) => part.type === "tool").map((part) => ({ name: part.name ?? part.tool, status: part.state?.status }));
      return { type: "assistant", agent: message.agent, text, tools, cost: message.cost, tokens: message.tokens };
    }
    default:
      return { type: message.type, at: message.time?.created };
  }
}
async function toAttachment(directory, file) {
  if (file.uri && !file.path) {
    return {
      uri: file.uri,
      name: file.name,
      description: file.description,
      source: { type: "inline" }
    };
  }
  const target = file.path ?? file.uri;
  if (!target) throw invalidInput("Each file needs a path or a uri.");
  if (/^data:/.test(target)) {
    return { uri: target, name: file.name, description: file.description, source: { type: "inline" } };
  }
  const absolute = path4.isAbsolute(target) ? target : path4.resolve(directory, target);
  const bytes = await fs4.readFile(absolute);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw invalidInput(`Attachment is larger than 10 MB: ${absolute} (${bytes.byteLength} bytes)`);
  }
  const mime = guessMime(absolute);
  return {
    uri: `data:${mime};base64,${bytes.toString("base64")}`,
    name: file.name ?? path4.basename(absolute),
    description: file.description,
    source: { type: "inline" }
  };
}
var MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".zip": "application/zip"
};
function guessMime(file) {
  return MIME[path4.extname(file).toLowerCase()] ?? "application/octet-stream";
}
function previewUri(uri) {
  return uri.startsWith("data:") ? `${uri.slice(0, 40)}\u2026 (${uri.length} chars)` : uri;
}

// src/tools/history.ts
import { z as z4 } from "zod";
function registerHistoryTools(server, ctx) {
  register(
    server,
    "opencode_session_history",
    {
      title: "Read session history",
      description: "Read a session's messages and totals. Useful for inspecting what an agent did, auditing tool calls, or exporting a transcript to another client.",
      inputSchema: {
        sessionID: z4.string(),
        limit: z4.number().int().min(1).max(200).optional().describe("Default 100"),
        cursor: z4.string().optional(),
        order: z4.enum(["asc", "desc"]).optional(),
        includeToolCalls: z4.boolean().optional().describe("Include tool calls in rendered output (default true)"),
        includeReasoning: z4.boolean().optional().describe("Include reasoning blocks (default false)"),
        format: z4.enum(["json", "markdown", "transcript"]).optional().describe("Default json")
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const { client } = await openClient(ctx);
      const [session, response] = await Promise.all([
        client.session.get({ sessionID: args.sessionID }),
        client.message.list({
          sessionID: args.sessionID,
          limit: args.limit ?? 100,
          order: args.order ?? "asc",
          cursor: args.cursor
        })
      ]);
      const format = args.format ?? "json";
      const messages = response.data.map((message) => render(message, args.includeReasoning ?? false));
      const result = {
        sessionID: args.sessionID,
        title: session.title,
        directory: session.location?.directory ?? (await workspaceFor(ctx)).directory,
        totals: {
          cost: session.cost,
          tokens: session.tokens,
          messageCount: response.data.length
        },
        cursor: response.cursor ?? null,
        messages
      };
      if (format === "json") return result;
      const markdown = toMarkdown(result.title, messages, args.includeToolCalls !== false);
      return { ...result, markdown };
    }
  );
}
function render(message, includeReasoning) {
  const at = message.time?.created;
  switch (message.type) {
    case "user":
      return { role: "user", at, text: message.text, attachments: message.files?.length ?? 0 };
    case "assistant": {
      const parts = message.content ?? [];
      return {
        role: "assistant",
        at,
        agent: message.agent,
        model: message.model,
        text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim(),
        reasoning: includeReasoning ? parts.filter((part) => part.type === "reasoning").map((part) => part.text).join("\n") : void 0,
        tools: parts.filter((part) => part.type === "tool").map((part) => ({
          name: part.name ?? part.tool,
          status: part.state?.status,
          input: part.state?.input,
          output: summarizeOutput(part.state?.output)
        })),
        cost: message.cost,
        tokens: message.tokens,
        finish: message.finish,
        error: message.error
      };
    }
    case "compaction":
      return { role: "compaction", at, state: message.state };
    case "shell":
      return { role: "shell", at, command: message.command };
    default:
      return { role: message.type ?? "event", at };
  }
}
function summarizeOutput(output) {
  if (output === void 0 || output === null) return void 0;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > 500 ? `${text.slice(0, 500)}\u2026` : text;
}
function toMarkdown(title, messages, includeTools) {
  const lines = [`# ${title ?? "Session transcript"}`, ""];
  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`## User`, "", message.text ?? "", "");
    } else if (message.role === "assistant") {
      lines.push(`## Assistant${message.agent ? ` (${message.agent})` : ""}`, "", message.text ?? "", "");
      if (includeTools && message.tools?.length) {
        for (const tool of message.tools) {
          lines.push(`- \`${tool.name}\` \u2014 ${tool.status ?? "unknown"}`);
        }
        lines.push("");
      }
    } else if (message.role === "compaction") {
      lines.push(`## Compaction`, "", `state: ${message.state ?? "unknown"}`, "");
    }
  }
  return lines.join("\n");
}

// src/tools/model.ts
import { z as z5 } from "zod";
import { promises as fs6 } from "fs";
import { parse } from "jsonc-parser";

// src/model-config.ts
import { existsSync as fsExistsSync, promises as fs5 } from "fs";
import os4 from "os";
import path5 from "path";
import { applyEdits, modify } from "jsonc-parser";
function modelConfigValue(model) {
  return {
    providerID: model.providerID,
    model: model.id,
    ...model.variant ? { variant: model.variant } : {}
  };
}
function globalConfigFile() {
  const configHome = process.env.XDG_CONFIG_HOME ?? path5.join(os4.homedir(), ".config");
  const base = path5.join(configHome, "opencode");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path5.join(base, name);
    if (existsSync(candidate)) return candidate;
  }
  return path5.join(base, "opencode.json");
}
async function projectConfigFile(directory) {
  const candidates = [
    path5.join(directory, "opencode.jsonc"),
    path5.join(directory, "opencode.json"),
    path5.join(directory, ".opencode", "opencode.jsonc"),
    path5.join(directory, ".opencode", "opencode.json")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return path5.join(directory, "opencode.json");
}
function existsSync(file) {
  return fsExistsSync(file);
}
async function writeConfigValue(file, keys, value) {
  let text = "{\n}\n";
  try {
    text = await fs5.readFile(file, "utf8");
    if (!text.trim()) text = "{\n}\n";
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") {
      throw new BridgeError("INTERNAL", `Cannot read ${file}: ${error.message}`);
    }
    await fs5.mkdir(path5.dirname(file), { recursive: true });
  }
  const edits = modify(text, keys, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
  });
  if (edits.length === 0) return;
  const next = applyEdits(text, edits);
  const temp = `${file}.${process.pid}.tmp`;
  await fs5.writeFile(temp, next, { mode: 384 });
  await fs5.rename(temp, file);
}
async function assignModel(options) {
  const value = modelConfigValue(options.model);
  if (options.scope === "agent") {
    if (!options.agent) {
      throw new BridgeError("INVALID_INPUT", "scope=agent requires agent");
    }
    const file2 = options.directory ? await projectConfigFile(options.directory) : globalConfigFile();
    const keys2 = ["agents", options.agent, "model"];
    await writeConfigValue(file2, keys2, value);
    return { file: file2, keys: keys2, value };
  }
  const file = options.scope === "global" ? globalConfigFile() : await projectConfigFile(options.directory ?? process.cwd());
  const keys = ["model"];
  await writeConfigValue(file, keys, value);
  return { file, keys, value };
}

// src/tools/model.ts
var modelRef2 = z5.object({
  providerID: z5.string(),
  id: z5.string(),
  variant: z5.string().optional()
});
function registerModelTools(server, ctx) {
  register(
    server,
    "opencode_model",
    {
      title: "Models",
      description: "List models, read the default, and assign models at four levels: session (immediate API switch), project (opencode.json in the workspace), global (~/.config/opencode/opencode.json), agent (agents.<id>.model). Session assignment wins for that conversation; project/global change the default for new sessions. Config edits preserve JSONC comments and are verified against model/default.",
      inputSchema: {
        action: z5.enum(["list", "default", "set"]),
        directory: z5.string().optional(),
        sessionID: z5.string().optional().describe("For scope=session"),
        model: modelRef2.optional().describe("Required for action=set"),
        type: z5.enum(["chat", "decision", "image"]).optional().describe("Filter for action=list"),
        scope: z5.enum(["session", "project", "global", "agent"]).optional().describe("Default: session when sessionID is given, otherwise project"),
        agent: z5.string().optional().describe("Agent id for scope=agent")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory);
      const { client } = await openClient(ctx);
      if (args.action === "list") {
        const response = await client.model.list({
          location: { directory: workspace.directory },
          types: args.type ? [args.type] : void 0
        });
        return {
          directory: workspace.directory,
          models: response.data.map((model) => ({
            providerID: model.providerID,
            id: model.modelID,
            name: model.name,
            type: model.type,
            family: model.family,
            status: model.status,
            variants: (model.variants ?? []).map((variant) => variant.id ?? variant.name ?? variant),
            capabilities: model.capabilities,
            cost: model.cost
          }))
        };
      }
      if (args.action === "default") {
        const response = await client.model.default({ location: { directory: workspace.directory } });
        return {
          directory: workspace.directory,
          model: response.data ? { providerID: response.data.providerID, id: response.data.modelID, name: response.data.name } : null
        };
      }
      if (!args.model) throw invalidInput("action=set requires a model { providerID, id }.");
      const scope = args.scope ?? (args.sessionID ? "session" : "project");
      if (scope === "session") {
        if (!args.sessionID) throw invalidInput("scope=session requires sessionID.");
        await client.session.switchModel({ sessionID: args.sessionID, model: args.model });
        const info = await client.session.get({ sessionID: args.sessionID }).catch(() => null);
        return { ok: true, scope, sessionID: args.sessionID, model: info?.model ?? args.model };
      }
      assertWritable(ctx, "changing the default model");
      if (scope === "agent" && !args.agent) throw invalidInput("scope=agent requires agent.");
      const written = await assignModel({
        scope,
        model: args.model,
        directory: workspace.directory,
        agent: args.agent
      });
      const fileVerified = await verifyFileValue(written.file, written.keys, written.value);
      if (scope !== "agent") {
        await client.location.reload().catch(() => void 0);
      }
      const runtime2 = scope === "agent" ? { verified: null, effective: null } : await verifyDefault(client, workspace.directory, args.model);
      return {
        ok: true,
        scope,
        agent: args.agent ?? null,
        file: written.file,
        keys: written.keys,
        value: written.value,
        fileVerified,
        runtimeVerified: runtime2.verified,
        effectiveModel: runtime2.effective,
        note: scope === "agent" ? "Written to the agent config. OpenCode does not expose the resolved per-agent model through the API, so only the file write can be verified; the agent's model takes effect on its next run." : "Changes apply to new sessions. An explicit session model still takes precedence. If runtimeVerified=false, a closer config file may override this value."
      };
    }
  );
}
async function verifyDefault(client, directory, expected) {
  let effective = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await client.model.default({ location: { directory } }).catch(() => null);
    effective = response?.data ?? null;
    if (effective && effective.providerID === expected.providerID && effective.modelID === expected.id) {
      return { verified: true, effective: { providerID: effective.providerID, id: effective.modelID } };
    }
    await delay(400);
  }
  return {
    verified: false,
    effective: effective ? { providerID: effective.providerID, id: effective.modelID } : null
  };
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function verifyFileValue(file, keys, expected) {
  try {
    const text = await fs6.readFile(file, "utf8");
    const data = parse(text);
    let current = data;
    for (const key of keys) current = current?.[key];
    return JSON.stringify(current) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

// src/tools/agent.ts
import { z as z7 } from "zod";

// src/tools/task.ts
import { z as z6 } from "zod";
var modelRef3 = z6.object({
  providerID: z6.string(),
  id: z6.string(),
  variant: z6.string().optional()
});
async function runTask(ctx, input) {
  assertWritable(ctx, "delegating tasks");
  const workspace = await workspaceFor(ctx, input.directory);
  const { client } = await openClient(ctx);
  const session = await client.session.create({
    location: { directory: workspace.directory },
    title: input.title ?? `Task: ${input.prompt.slice(0, 60)}`,
    agent: input.agent ?? "general",
    model: input.model,
    parentID: input.parentSessionID
  });
  const result = await executePrompt(ctx, {
    sessionID: session.id,
    text: input.prompt,
    wait: input.wait,
    timeoutMs: input.timeoutMs ?? 45e3
  });
  return {
    ...result,
    sessionID: session.id,
    parentSessionID: session.parentID ?? null,
    directory: workspace.directory,
    agent: session.agent,
    model: session.model
  };
}
function registerTaskTools(server, ctx) {
  register(
    server,
    "opencode_task",
    {
      title: "Delegate a task to OpenCode",
      description: "One-shot delegation: create a session in a workspace, send a prompt, wait for the result, and return the answer plus the subagent transcript. Use this for 'have OpenCode do X in this repo' requests; use opencode_session_* when you need a persistent conversation.",
      inputSchema: {
        directory: z6.string().optional().describe("Absolute workspace; defaults to the client's directory"),
        prompt: z6.string().describe("What the agent should do"),
        agent: z6.string().optional().describe("Agent id (default general; try explore for read-only research)"),
        title: z6.string().optional(),
        model: modelRef3.optional(),
        parentSessionID: z6.string().optional().describe("Attach the task as a subagent of this session"),
        wait: z6.boolean().optional().describe("Default true"),
        timeoutMs: z6.number().int().min(1e3).max(36e5).optional().describe("Default 45000")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => runTask(ctx, args)
  );
}

// src/tools/agent.ts
function registerAgentTools(server, ctx) {
  register(
    server,
    "opencode_agent",
    {
      title: "Agents and subagents",
      description: "List available agents (primary and subagent), switch the agent of a session, or delegate a one-shot task to a subagent. Delegation creates a real child session and returns its transcript.",
      inputSchema: {
        action: z7.enum(["list", "set", "delegate"]),
        directory: z7.string().optional(),
        sessionID: z7.string().optional().describe("For action=set"),
        agent: z7.string().optional().describe("Agent id, e.g. general, explore, build"),
        prompt: z7.string().optional().describe("For action=delegate"),
        parentSessionID: z7.string().optional(),
        timeoutMs: z7.number().int().min(1e3).max(36e5).optional()
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory);
      const { client } = await openClient(ctx);
      if (args.action === "list") {
        const response = await client.agent.list({ location: { directory: workspace.directory } });
        return {
          directory: workspace.directory,
          agents: response.data.map((agent) => ({
            id: agent.id,
            name: agent.name,
            mode: agent.mode,
            hidden: agent.hidden,
            description: agent.description,
            model: agent.model
          }))
        };
      }
      if (args.action === "set") {
        if (!args.sessionID) throw invalidInput("action=set requires sessionID");
        if (!args.agent) throw invalidInput("action=set requires agent");
        await client.session.switchAgent({ sessionID: args.sessionID, agent: args.agent });
        return { ok: true, sessionID: args.sessionID, agent: args.agent };
      }
      if (!args.prompt) throw invalidInput("action=delegate requires prompt");
      return runTask(ctx, {
        directory: workspace.directory,
        prompt: args.prompt,
        agent: args.agent ?? "general",
        parentSessionID: args.parentSessionID,
        timeoutMs: args.timeoutMs
      });
    }
  );
}

// src/tools/files.ts
import { promises as fs7 } from "fs";
import path6 from "path";
import { z as z8 } from "zod";
var MAX_BYTES = 10 * 1024 * 1024;
function registerFileTools(server, ctx) {
  register(
    server,
    "opencode_file_attach",
    {
      title: "Attach a file to a session",
      description: "Upload a file into a session. Provide `path` (server-side file) or `data` (base64 bytes). When `text` is supplied the file is sent immediately as a prompt and the answer is returned; otherwise the attachment descriptor and stored path are returned for a later prompt.",
      inputSchema: {
        sessionID: z8.string(),
        path: z8.string().optional().describe("Absolute or workspace-relative path"),
        data: z8.string().optional().describe("Base64-encoded file contents"),
        name: z8.string().optional(),
        mime: z8.string().optional(),
        description: z8.string().optional(),
        text: z8.string().optional().describe("Also send this prompt with the attachment"),
        wait: z8.boolean().optional()
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      assertWritable(ctx, "uploading files");
      if (!args.path && !args.data) throw invalidInput("Provide path or data.");
      const { client } = await openClient(ctx);
      const session = await client.session.get({ sessionID: args.sessionID });
      const directory = session.location?.directory ?? (await workspaceFor(ctx)).directory;
      let storedPath;
      let bytes;
      let name = args.name;
      if (args.data) {
        bytes = Buffer.from(args.data, "base64");
        if (bytes.byteLength > MAX_BYTES) throw invalidInput("File is larger than 10 MB.");
        name = name ?? `attachment-${Date.now()}.bin`;
        const safeName = path6.basename(name).replace(/[^A-Za-z0-9._-]+/g, "_");
        const dir = path6.join(directory, ".opencode", "attachments");
        await fs7.mkdir(dir, { recursive: true });
        storedPath = path6.join(dir, safeName);
        await fs7.writeFile(storedPath, bytes);
      } else {
        const absolute = path6.isAbsolute(args.path) ? args.path : path6.resolve(directory, args.path);
        const stat = await fs7.stat(absolute).catch(() => null);
        if (!stat?.isFile()) throw invalidInput(`File not found: ${absolute}`);
        if (stat.size > MAX_BYTES) throw invalidInput(`File is larger than 10 MB: ${absolute}`);
        bytes = await fs7.readFile(absolute);
        name = name ?? path6.basename(absolute);
        storedPath = absolute;
      }
      const mime = args.mime ?? guessMime(storedPath ?? name ?? "");
      const attachment = {
        uri: `data:${mime};base64,${bytes.toString("base64")}`,
        name,
        description: args.description,
        source: { type: "inline" }
      };
      if (args.text) {
        const result = await executePrompt(ctx, {
          sessionID: args.sessionID,
          text: args.text,
          files: [{ path: storedPath, name, description: args.description }],
          wait: args.wait
        });
        return { ok: true, storedPath, attachment: { name, mime, size: bytes.byteLength }, result };
      }
      return {
        ok: true,
        storedPath,
        attachment: {
          name,
          mime,
          size: bytes.byteLength,
          uriPreview: `data:${mime};base64,\u2026 (${bytes.byteLength} bytes)`
        },
        hint: "Pass storedPath to opencode_session_prompt.files or call opencode_file_attach again with text."
      };
    }
  );
}

// src/tools/mcp.ts
import { z as z9 } from "zod";
var localConfig = z9.object({
  type: z9.literal("local"),
  command: z9.array(z9.string()),
  cwd: z9.string().optional(),
  environment: z9.record(z9.string(), z9.string()).optional(),
  disabled: z9.boolean().optional()
});
var remoteConfig = z9.object({
  type: z9.literal("remote"),
  url: z9.string(),
  headers: z9.record(z9.string(), z9.string()).optional(),
  disabled: z9.boolean().optional()
});
function registerMcpTools(server, ctx) {
  register(
    server,
    "opencode_mcp",
    {
      title: "OpenCode MCP servers",
      description: "Inspect and manage the MCP servers that OpenCode itself uses (not this bridge). Actions: list (servers + connection status), resources (tool/resource catalog), add (local or remote), remove, connect, disconnect. Server enablement is global per OpenCode project; per-session tool filtering is done with session permissions.",
      inputSchema: {
        action: z9.enum(["list", "resources", "add", "remove", "connect", "disconnect"]),
        directory: z9.string().optional(),
        server: z9.string().optional().describe("Server name, for add/remove/connect/disconnect"),
        config: z9.union([localConfig, remoteConfig]).optional().describe("Server config for action=add"),
        types: z9.array(z9.string()).optional().describe("Resource types for action=resources")
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory);
      const location = { directory: workspace.directory };
      const { client } = await openClient(ctx);
      if (args.action === "list") {
        const response = await client.mcp.list({ location });
        return {
          directory: workspace.directory,
          servers: response.data.map((entry) => ({
            name: entry.name,
            title: entry.title,
            status: entry.status,
            integrationID: entry.integrationID
          }))
        };
      }
      if (args.action === "resources") {
        const response = await client.mcp.resource.catalog({ location });
        return { directory: workspace.directory, catalog: response.data };
      }
      assertWritable(ctx, `MCP ${args.action}`);
      if (!args.server) throw invalidInput(`action=${args.action} requires server`);
      if (args.action === "add") {
        if (!args.config) throw invalidInput("action=add requires config");
        await client.mcp.add({ server: args.server, location, config: args.config });
        return { ok: true, added: args.server, config: args.config };
      }
      if (args.action === "remove") {
        await client.mcp.remove({ server: args.server, location });
        return { ok: true, removed: args.server };
      }
      if (args.action === "connect") {
        await client.mcp.connect({ server: args.server, location });
        return { ok: true, connected: args.server };
      }
      await client.mcp.disconnect({ server: args.server, location });
      return { ok: true, disconnected: args.server };
    }
  );
}

// src/tools/permission.ts
import { z as z10 } from "zod";
var PROFILES = {
  "danger-full-access": [{ action: "*", resource: "*", effect: "allow" }],
  "workspace-write": [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" }
  ],
  "read-only": [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "bash", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "*", resource: "*", effect: "allow" }
  ]
};
function registerPermissionTools(server, ctx) {
  register(
    server,
    "opencode_permission",
    {
      title: "Permission requests",
      description: "Headless runs block when OpenCode asks for permission. Use action=list to see pending requests and action=reply to approve or reject them. action=policy reports the bridge profile, or applies its ruleset to a session (approximate: OpenCode evaluates rules in order, so profiles are best-effort).",
      inputSchema: {
        action: z10.enum(["list", "reply", "policy"]),
        directory: z10.string().optional(),
        sessionID: z10.string().optional(),
        requestID: z10.string().optional(),
        decision: z10.enum(["once", "always", "reject"]).optional(),
        message: z10.string().optional(),
        profile: z10.enum(["read-only", "workspace-write", "danger-full-access"]).optional()
      },
      annotations: { readOnlyHint: false }
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory);
      const { client, config } = await openClient(ctx);
      if (args.action === "list") {
        const response = await client.permission.request.list({ location: { directory: workspace.directory } });
        return {
          directory: workspace.directory,
          requests: response.data.map((request) => ({
            requestID: request.id,
            sessionID: request.sessionID,
            action: request.action,
            resources: request.resources,
            save: request.save,
            message: request.message
          }))
        };
      }
      if (args.action === "reply") {
        assertWritable(ctx, "replying to permission requests");
        if (!args.requestID) throw new Error("action=reply requires requestID");
        if (!args.decision) throw new Error("action=reply requires decision");
        const sessionID = args.sessionID ?? await findSessionForRequest(ctx, args.requestID);
        await client.permission.reply({
          sessionID,
          requestID: args.requestID,
          decision: args.decision,
          message: args.message
        });
        return { ok: true, requestID: args.requestID, decision: args.decision };
      }
      const profile = args.profile ?? config.permissionProfile;
      if (args.profile && args.sessionID) {
        assertWritable(ctx, "changing session permissions");
        await client.session.update({ sessionID: args.sessionID, permissions: PROFILES[profile] });
        return { ok: true, sessionID: args.sessionID, profile, permissions: PROFILES[profile] };
      }
      return {
        profile,
        permissions: PROFILES[profile],
        note: "Pass sessionID with profile to apply these rules to an existing session."
      };
    }
  );
}
async function findSessionForRequest(ctx, requestID) {
  const { client } = await openClient(ctx);
  const response = await client.permission.request.list();
  const match = response.data.find((request) => request.id === requestID);
  if (!match) throw new Error(`No pending permission request with id ${requestID}`);
  return match.sessionID;
}

// src/tools/index.ts
function registerTools(server, ctx, profile = "full") {
  registerConfigTools(server, ctx);
  registerSessionTools(server, ctx);
  registerPromptTools(server, ctx);
  registerHistoryTools(server, ctx);
  registerModelTools(server, ctx);
  registerPermissionTools(server, ctx);
  registerTaskTools(server, ctx);
  if (profile === "full") {
    registerSessionAdminTools(server, ctx);
    registerAgentTools(server, ctx);
    registerFileTools(server, ctx);
    registerMcpTools(server, ctx);
  }
  const names = [
    "opencode_status",
    "opencode_configure",
    "opencode_workspace",
    "opencode_session_create",
    "opencode_session_prompt",
    "opencode_session_history",
    "opencode_model",
    "opencode_permission",
    "opencode_task"
  ];
  if (profile === "full") {
    names.push(
      "opencode_session_list",
      "opencode_session_get",
      "opencode_session_move",
      "opencode_session_delete",
      "opencode_session_interrupt",
      "opencode_session_compact",
      "opencode_agent",
      "opencode_file_attach",
      "opencode_mcp"
    );
  }
  return names;
}

// src/index.ts
var VERSION = "0.1.0";
function parseArgs(argv) {
  const options = {
    command: "serve",
    http: false,
    host: "127.0.0.1",
    port: 7777,
    allowRemoteUrl: false,
    readOnly: false,
    profile: "full",
    discover: false,
    json: false
  };
  const args = [...argv];
  for (const command of ["configure", "status", "help", "serve"]) {
    const index = args.indexOf(command);
    if (index >= 0) {
      options.command = command;
      args.splice(index, 1);
      break;
    }
  }
  while (args.length > 0) {
    const arg = args.shift();
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, void 0];
    const next = () => inline ?? args.shift();
    switch (flag) {
      case "--http":
        options.http = true;
        break;
      case "--host":
        options.host = next() ?? options.host;
        break;
      case "--port":
        options.port = Number(next() ?? options.port);
        break;
      case "--url":
        options.url = next();
        break;
      case "--password":
        options.password = next();
        break;
      case "--directory":
        options.directory = next();
        break;
      case "--allow-remote-url":
        options.allowRemoteUrl = true;
        break;
      case "--read-only":
        options.readOnly = true;
        break;
      case "--profile": {
        const value = next();
        options.profile = value === "minimal" ? "minimal" : "full";
        break;
      }
      case "--discover":
        options.discover = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.command = "help";
        break;
      case "-v":
      case "--version":
        options.command = "version";
        break;
      default:
        if (arg.startsWith("-")) {
          process.stderr.write(`Unknown option: ${arg}
`);
          options.command = "help";
        }
    }
  }
  return options;
}
var HELP = `opencode-mcp-server ${VERSION}

Expose an OpenCode v2 server to any MCP client (Codex, Claude, Anti-Gravity, ...).

Usage:
  opencode-mcp-server                      Run over stdio (default)
  opencode-mcp-server --http --port 7777   Run the Streamable HTTP transport
  opencode-mcp-server configure --url http://127.0.0.1:4096
  opencode-mcp-server status [--json]

Configuration (required):
  OPENCODE_URL         OpenCode server address, e.g. http://127.0.0.1:4096
  OPENCODE_PASSWORD    OpenCode Basic-auth password (username is fixed to "opencode")

Options:
  --url <url>            Set the server address for this process
  --password <pw>        Set the password for this process
  --directory <path>     Default workspace directory
  --profile <full|minimal>  Tool surface (default full, 18 tools)
  --read-only            Disable tools that mutate sessions or files
  --allow-remote-url     Permit non-loopback OpenCode addresses
  --discover             Read credentials from the local OpenCode service file
  --host <host>          HTTP bind address (default 127.0.0.1)
  --port <port>          HTTP port (default 7777)
  --json                 Machine-readable output for "status"
`;
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (options.command === "version") {
    process.stdout.write(`${VERSION}
`);
    return;
  }
  const runtime2 = {};
  if (options.url) runtime2.url = options.url;
  if (options.password) {
    registerSecret(options.password);
    runtime2.password = options.password;
  }
  if (options.directory) runtime2.defaultDirectory = path7.resolve(options.directory);
  if (Object.keys(runtime2).length > 0) setRuntimeConfig(runtime2);
  if (options.discover) {
    const discovered = await readServiceFile();
    if (discovered) {
      registerSecret(discovered.password);
      setRuntimeConfig({ url: discovered.url, password: discovered.password });
      log.info(`Discovered OpenCode service at ${discovered.url}`);
    } else {
      log.warn(`--discover: no service file found (looked in ${OPENCODE_SERVICE_PATHS.join(", ")})`);
    }
  }
  const bridge = new OpenCodeBridge({ allowRemoteUrl: options.allowRemoteUrl });
  if (options.command === "configure") {
    const state = await runConfigure(bridge, options);
    printState(state, options.json);
    if (!state.connected) process.exitCode = 1;
    return;
  }
  if (options.command === "status") {
    const state = await bridge.probe();
    printState(state, options.json);
    if (!state.connected) process.exitCode = 1;
    return;
  }
  await bridge.reload();
  const context = {
    bridge,
    readOnly: options.readOnly,
    allowRemoteUrl: options.allowRemoteUrl,
    rootsProvider: async () => []
  };
  if (options.http) {
    const { startHttpServer } = await import("./http-RJPWHU4R.js");
    await startHttpServer(() => createServer(context, options), {
      host: options.host,
      port: options.port,
      configure: (input) => bridge.configure(input, { allowRemoteUrl: options.allowRemoteUrl }),
      clearConfig: (input) => bridge.clear(input)
    });
    log.info(`HTTP transport listening on http://${options.host}:${options.port}/mcp`);
    return;
  }
  const server = createServer(context, options);
  context.rootsProvider = async () => {
    try {
      const result = await server.server.listRoots();
      return (result.roots ?? []).map((root) => root.uri);
    } catch {
      return [];
    }
  };
  await server.connect(new StdioServerTransport());
  log.info(`stdio transport ready (profile=${options.profile}, readOnly=${options.readOnly})`);
}
function createServer(context, options) {
  const server = new McpServer(
    { name: "opencode-mcp-server", version: VERSION },
    {
      instructions: "This server drives a local OpenCode v2 instance. Start with opencode_status; if it is not configured, call opencode_configure with the server address and password. Sessions are created in the client's workspace by default. Use opencode_task for one-shot delegated work and opencode_session_* for persistent conversations."
    }
  );
  registerTools(server, context, options.profile);
  return server;
}
async function runConfigure(bridge, options) {
  const current = bridge.configuration ?? await bridge.reload();
  const promptedUrl = options.url ?? current?.url ?? await promptText("OpenCode server URL [http://127.0.0.1:4096]: ").catch(() => "");
  const url = promptedUrl || "http://127.0.0.1:4096";
  const password = options.password ?? current?.password ?? await promptHidden("OpenCode password: ");
  const state = await bridge.configure({ url, password, persist: true }, { allowRemoteUrl: options.allowRemoteUrl });
  return state;
}
function printState(state, json) {
  process.stdout.write(JSON.stringify(state, null, json ? 0 : 2) + "\n");
}
async function promptText(question) {
  const readline = await import("readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
function promptHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "") {
          finish();
          process.exit(130);
        }
        if (char === "\x7F") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
//# sourceMappingURL=index.js.map