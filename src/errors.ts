import { redact } from "./log.js"

export type BridgeErrorCode =
  | "OPENCODE_NOT_CONFIGURED"
  | "OPENCODE_UNAUTHORIZED"
  | "OPENCODE_VERSION_UNSUPPORTED"
  | "OPENCODE_UNREACHABLE"
  | "OPENCODE_ERROR"
  | "INVALID_INPUT"
  | "PATH_NOT_ALLOWED"
  | "NOT_FOUND"
  | "INTERNAL"

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly hint?: string
  readonly details?: unknown

  constructor(code: BridgeErrorCode, message: string, options: { hint?: string; details?: unknown } = {}) {
    super(message)
    this.name = "BridgeError"
    this.code = code
    this.hint = options.hint
    this.details = options.details
  }

  toJSON() {
    return { code: this.code, message: redact(this.message), hint: this.hint ? redact(this.hint) : undefined }
  }
}

export function notConfigured(): BridgeError {
  return new BridgeError(
    "OPENCODE_NOT_CONFIGURED",
    "OpenCode MCP server is not configured yet.",
    {
      hint:
        "Set OPENCODE_URL (for example http://127.0.0.1:4096) and OPENCODE_PASSWORD in this MCP server's configuration, " +
        "or call opencode_configure with the same values. Run opencode_status to inspect the current state.",
    },
  )
}

export function unauthorized(): BridgeError {
  return new BridgeError("OPENCODE_UNAUTHORIZED", "OpenCode rejected the configured password (HTTP 401).", {
    hint: "Check OPENCODE_PASSWORD against the value in ~/.config/opencode/service.json, then retry opencode_configure.",
  })
}

export function versionUnsupported(version: string): BridgeError {
  return new BridgeError("OPENCODE_VERSION_UNSUPPORTED", `OpenCode v${version} is not supported; this bridge requires v2.`, {
    hint: "Upgrade OpenCode (opencode upgrade) so GET /api/info reports a 2.x version.",
  })
}

export function unreachable(url: string, cause: unknown): BridgeError {
  return new BridgeError("OPENCODE_UNREACHABLE", `Cannot reach the OpenCode server at ${url}.`, {
    hint: "Start it with `opencode serve` (or the TUI) and confirm the address, then run opencode_status.",
    details: cause instanceof Error ? cause.message : String(cause),
  })
}

export function invalidInput(message: string): BridgeError {
  return new BridgeError("INVALID_INPUT", message)
}

export function notFound(what: string): BridgeError {
  return new BridgeError("NOT_FOUND", `${what} was not found.`)
}

export function fromUnknown(error: unknown, fallbackMessage = "OpenCode request failed."): BridgeError {
  if (error instanceof BridgeError) return error

  const anyError = error as { _tag?: string; status?: number; message?: string; body?: unknown; data?: unknown }
  const tag = anyError?._tag ?? ""
  const status = typeof anyError?.status === "number" ? anyError.status : undefined

  if (status === 401 || /unauthori[sz]ed/i.test(tag)) return unauthorized()
  if (status === 404 || /NotFound/i.test(tag)) {
    return new BridgeError("NOT_FOUND", anyError?.message ?? "Resource not found.")
  }
  if (/Version|Unsupported/i.test(tag)) {
    return new BridgeError("OPENCODE_ERROR", anyError?.message ?? fallbackMessage)
  }
  if (status !== undefined && status >= 400) {
    return new BridgeError("OPENCODE_ERROR", anyError?.message ?? fallbackMessage, { details: anyError?.body ?? anyError?.data })
  }

  const message = anyError?.message ?? String(error)
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message)) {
    return new BridgeError("OPENCODE_UNREACHABLE", message)
  }
  return new BridgeError("OPENCODE_ERROR", message || fallbackMessage)
}

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  [key: string]: unknown
}

export function ok(data: unknown): ToolTextResult {
  const pretty = JSON.stringify(data, null, 2) ?? "null"
  // Large payloads are compacted: indentation costs real context tokens in the client.
  const text = pretty.length > 2_000 ? (JSON.stringify(data) ?? pretty) : pretty
  return { content: [{ type: "text", text }] }
}

export function fail(error: unknown): ToolTextResult {
  const bridgeError = fromUnknown(error)
  const payload = {
    ok: false,
    error: bridgeError.toJSON(),
  }
  const hint = bridgeError.hint ? `\n${redact(bridgeError.hint)}` : ""
  return {
    isError: true,
    content: [{ type: "text", text: `${redact(bridgeError.message)}${hint}\n\n${stringify(payload)}` }],
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
