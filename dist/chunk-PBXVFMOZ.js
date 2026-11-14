#!/usr/bin/env node

// src/log.ts
var secrets = /* @__PURE__ */ new Set();
function registerSecret(value) {
  if (value && value.length >= 3) secrets.add(value);
}
function redact(input) {
  let out = input;
  for (const secret of secrets) {
    out = out.split(secret).join("\xABredacted\xBB");
  }
  out = out.replace(
    /(authorization"?\s*[:=]\s*"?)([^"\n,}]+)/gi,
    (_match, prefix, value) => value.includes("\xABredacted\xBB") ? `${prefix}${value}` : `${prefix}\xABredacted\xBB`
  );
  out = out.replace(/("(?:password|apiKey|token|secret)"\s*:\s*")([^"]*)(")/gi, "$1\xABredacted\xBB$3");
  out = out.replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1\xABredacted\xBB");
  return out;
}
var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function threshold() {
  const raw = (process.env.OPENCODE_MCP_LOG ?? "info").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}
function write(level, msg, extra) {
  if (LEVELS[level] < threshold()) return;
  const line = `[opencode-mcp] ${level}: ${redact(msg)}${extra === void 0 ? "" : " " + redact(safeJson(extra))}`;
  process.stderr.write(line + "\n");
}
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
var log = {
  debug: (msg, extra) => write("debug", msg, extra),
  info: (msg, extra) => write("info", msg, extra),
  warn: (msg, extra) => write("warn", msg, extra),
  error: (msg, extra) => write("error", msg, extra)
};

export {
  registerSecret,
  redact,
  log
};
//# sourceMappingURL=chunk-PBXVFMOZ.js.map