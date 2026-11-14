import { OpenCode, type OpenCodeClient } from "@opencode/client"
import {
  authHeader,
  clearRuntimeConfig,
  describeConfig,
  getRuntimeConfig,
  isPrivateHost,
  normalizeUrl,
  removeConfigFile,
  replaceRuntimeConfig,
  resolveConfig,
  saveConfigFile,
  setRuntimeConfig,
  type BridgeConfig,
} from "./config.js"
import { BridgeError, invalidInput, notConfigured, unauthorized, unreachable, versionUnsupported } from "./errors.js"
import { log } from "./log.js"

export interface ConnectionState {
  configured: boolean
  connected: boolean
  url?: string
  version?: string
  hostname?: string
  pid?: number
  error?: "not_configured" | "unauthorized" | "version_unsupported" | "unreachable" | "error"
  message?: string
  hint?: string
}

export interface ConfigureInput {
  url?: string
  password?: string
  persist?: boolean
  test?: boolean
}

export interface ConfigureOptions {
  allowRemoteUrl: boolean
}

const PROBE_TIMEOUT_MS = 5_000
const VERSION_RE = /^2\./

export class OpenCodeBridge {
  private config: BridgeConfig | null = null
  private clientInstance: OpenCodeClient | null = null
  private clientKey = ""
  private lastState: ConnectionState = { configured: false, connected: false, error: "not_configured" }

  constructor(private readonly options: ConfigureOptions) {}

  get configuration(): BridgeConfig | null {
    return this.config
  }

  /** Re-read configuration from runtime/env/file and rebuild the client when it changed. */
  async reload(): Promise<BridgeConfig | null> {
    this.config = await resolveConfig()
    if (!this.config) {
      this.clientInstance = null
      this.clientKey = ""
      this.lastState = { configured: false, connected: false, error: "not_configured" }
      return null
    }
    const key = `${this.config.url}\u0000${this.config.password}`
    if (key !== this.clientKey) {
      this.clientInstance = buildClient(this.config)
      this.clientKey = key
      this.lastState = { configured: true, connected: false }
    }
    return this.config
  }

  async client(): Promise<OpenCodeClient> {
    const config = await this.reload()
    if (!config || !this.clientInstance) throw notConfigured()
    return this.clientInstance
  }

  async configOrThrow(): Promise<BridgeConfig> {
    const config = await this.reload()
    if (!config) throw notConfigured()
    return config
  }

  async state(): Promise<ConnectionState> {
    return this.lastState
  }

  /** Full health check: reachability + auth + v2 gate. */
  async probe(): Promise<ConnectionState> {
    const config = await this.reload()
    if (!config) {
      const provenance = await describeConfig()
      this.lastState = {
        configured: false,
        connected: false,
        error: "not_configured",
        url: provenance.url.value,
        message: "OpenCode MCP server is not configured yet.",
        hint:
          "Set OPENCODE_URL (for example http://127.0.0.1:4096) and OPENCODE_PASSWORD, " +
          "or call opencode_configure. Run opencode_status for details.",
      }
      return this.lastState
    }
    return this.probeWith(config)
  }

  private async probeWith(config: BridgeConfig): Promise<ConnectionState> {
    const client = buildClient(config)
    try {
      const info = await client.server.info({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      const version = String(info.version ?? "")
      if (!VERSION_RE.test(version)) {
        this.lastState = {
          configured: true,
          connected: false,
          url: config.url,
          version,
          error: "version_unsupported",
          message: `OpenCode v${version || "unknown"} is not supported; v2 is required.`,
          hint: "Run `opencode upgrade` so GET /api/info reports 2.x.",
        }
        return this.lastState
      }
      this.lastState = {
        configured: true,
        connected: true,
        url: config.url,
        version,
        hostname: info.hostname,
        pid: info.pid,
      }
      return this.lastState
    } catch (error) {
      this.lastState = stateFromError(config.url, error)
      return this.lastState
    }
  }

  /**
   * Validate and apply new credentials. Nothing changes when validation fails.
   * `persist` is opt-in; the default is process-lifetime only.
   */
  async configure(input: ConfigureInput, options: ConfigureOptions = this.options): Promise<ConnectionState> {
    const current = await resolveConfig()
    const runtime = getRuntimeConfig()
    const url = input.url ?? current?.url ?? runtime.url
    const password = input.password ?? current?.password ?? runtime.password

    if (!url) throw invalidInput("A server address is required (for example http://127.0.0.1:4096).")
    if (!password) throw invalidInput("A password is required. Find it in ~/.config/opencode/service.json.")

    const normalized = normalizeUrl(url)
    if (!isPrivateHost(normalized) && !options.allowRemoteUrl) {
      throw invalidInput(
        `Refusing remote host ${new URL(normalized).hostname}: only loopback/private addresses are allowed by default. ` +
          "Start the bridge with --allow-remote-url if this is intentional.",
      )
    }

    const candidate: BridgeConfig = {
      url: normalized,
      password,
      defaultDirectory: current?.defaultDirectory ?? runtime.defaultDirectory,
      allowedRoots: current?.allowedRoots ?? runtime.allowedRoots,
      permissionProfile: current?.permissionProfile ?? "workspace-write",
    }

    const state = await this.probeWith(candidate)
    if (!state.connected) {
      const error = stateToError(state)
      throw error
    }

    if (input.test) {
      return state
    }

    const previous = getRuntimeConfig()
    replaceRuntimeConfig({ ...previous, url: normalized, password })
    await this.reload()

    if (input.persist) {
      try {
        await saveConfigFile({ url: normalized, password })
      } catch (error) {
        replaceRuntimeConfig(previous)
        await this.reload()
        throw new BridgeError("INTERNAL", `Could not write the config file: ${(error as Error).message}`)
      }
    }

    log.info(`Configured OpenCode connection to ${normalized}`)
    return this.probe()
  }

  /** Forget runtime credentials and, optionally, the stored config file. */
  async clear(options: { includeFile?: boolean } = {}): Promise<ConnectionState> {
    clearRuntimeConfig()
    if (options.includeFile) await removeConfigFile()
    await this.reload()
    return this.probe()
  }
}

function buildClient(config: BridgeConfig): OpenCodeClient {
  return OpenCode.make({
    baseUrl: config.url,
    headers: { authorization: authHeader(config.password) },
  })
}

function stateFromError(url: string, error: unknown): ConnectionState {
  const bridgeError = asBridgeError(url, error)
  return {
    configured: true,
    connected: false,
    url,
    error:
      bridgeError.code === "OPENCODE_UNAUTHORIZED"
        ? "unauthorized"
        : bridgeError.code === "OPENCODE_UNREACHABLE"
          ? "unreachable"
          : bridgeError.code === "OPENCODE_VERSION_UNSUPPORTED"
            ? "version_unsupported"
            : "error",
    message: bridgeError.message,
    hint: bridgeError.hint,
  }
}

function asBridgeError(url: string, error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  const anyError = error as { _tag?: string; status?: number; message?: string }
  const tag = anyError?._tag ?? ""
  if (tag === "UnauthorizedError" || anyError?.status === 401) return unauthorized()
  if (tag === "UnsupportedModelError") {
    return new BridgeError("OPENCODE_ERROR", anyError?.message ?? "Unsupported model.")
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|aborted|timeout/i.test(anyError?.message ?? "")) {
    return unreachable(url, error)
  }
  return new BridgeError("OPENCODE_ERROR", anyError?.message ?? String(error))
}

export function stateToError(state: ConnectionState): BridgeError {
  const hint = state.hint
  switch (state.error) {
    case "not_configured":
      return notConfigured()
    case "unauthorized":
      return unauthorized()
    case "version_unsupported":
      return versionUnsupported(state.version ?? "unknown")
    case "unreachable":
      return unreachable(state.url ?? "the configured URL", state.message)
    default:
      return new BridgeError("OPENCODE_ERROR", state.message ?? "OpenCode request failed.", { hint })
  }
}
