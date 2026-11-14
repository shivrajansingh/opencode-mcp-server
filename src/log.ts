/**
 * stderr-only logging. stdout is the MCP transport channel and must never be polluted.
 */

const secrets = new Set<string>()

/** Register a value that must never appear in logs or tool output. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 3) secrets.add(value)
}

export function forgetSecret(value: string | null | undefined): void {
  if (value) secrets.delete(value)
}

export function redact(input: string): string {
  let out = input
  for (const secret of secrets) {
    out = out.split(secret).join("«redacted»")
  }
  // Belt-and-braces patterns for values we were never told about.
  out = out.replace(/(authorization"?\s*[:=]\s*"?)([^"\n,}]+)/gi, (_match, prefix: string, value: string) =>
    value.includes("«redacted»") ? `${prefix}${value}` : `${prefix}«redacted»`,
  )
  out = out.replace(/("(?:password|apiKey|token|secret)"\s*:\s*")([^"]*)(")/gi, "$1«redacted»$3")
  out = out.replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1«redacted»")
  return out
}

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const raw = (process.env.OPENCODE_MCP_LOG ?? "info").toLowerCase()
  return LEVELS[(raw as LogLevel)] ?? LEVELS.info
}

function write(level: LogLevel, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold()) return
  const line = `[opencode-mcp] ${level}: ${redact(msg)}${extra === undefined ? "" : " " + redact(safeJson(extra))}`
  process.stderr.write(line + "\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
}
