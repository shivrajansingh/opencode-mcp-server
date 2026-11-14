import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { invalidInput } from "./errors.js"
import { log, registerSecret } from "./log.js"

export type PermissionProfile = "read-only" | "workspace-write" | "danger-full-access"

export interface BridgeConfig {
  url: string
  password: string
  defaultDirectory?: string
  allowedRoots?: string[]
  permissionProfile: PermissionProfile
}

export type PartialConfig = Partial<{
  url: string
  password: string
  defaultDirectory: string
  allowedRoots: string[]
  permissionProfile: PermissionProfile
}>

export const PROFILE_VALUES: PermissionProfile[] = ["read-only", "workspace-write", "danger-full-access"]

const USERNAME = "opencode"
const ENV_URL = "OPENCODE_URL"
const ENV_PASSWORD = "OPENCODE_PASSWORD"

let runtime: PartialConfig = {}

export function configPath(): string {
  return process.env.OPENCODE_MCP_CONFIG ?? path.join(os.homedir(), ".config", "opencode-mcp", "config.json")
}

export function setRuntimeConfig(partial: PartialConfig): void {
  runtime = { ...runtime, ...partial }
  if (runtime.password) registerSecret(runtime.password)
}

export function getRuntimeConfig(): PartialConfig {
  return { ...runtime }
}

export function replaceRuntimeConfig(next: PartialConfig): void {
  runtime = { ...next }
  if (runtime.password) registerSecret(runtime.password)
}

export function clearRuntimeConfig(): void {
  runtime = {}
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw invalidInput("The OpenCode server URL is empty.")
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw invalidInput(`"${trimmed}" is not a valid URL. Expected something like http://127.0.0.1:4096.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidInput(`Unsupported protocol "${parsed.protocol}". Use http:// or https://.`)
  }
  if (!parsed.hostname) throw invalidInput("The URL has no hostname.")
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
  return `${parsed.protocol}//${parsed.host}${pathname}`
}

/** Loopback or RFC1918 host. Public hosts need an explicit --allow-remote-url. */
export function isPrivateHost(rawUrl: string): boolean {
  let host: string
  try {
    host = new URL(rawUrl).hostname
  } catch {
    return false
  }
  if (host === "localhost" || host === "::1" || host === "[::1]") return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  const m = /^172\.(\d{1,3})\./.exec(host)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

async function readFileConfig(): Promise<PartialConfig | null> {
  const file = configPath()
  try {
    const raw = await fs.readFile(file, "utf8")
    const parsed = JSON.parse(raw) as PartialConfig
    return sanitize(parsed, file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      log.warn(`Ignoring unreadable config file at ${file}`, { code })
    }
    return null
  }
}

function sanitize(input: PartialConfig, origin: string): PartialConfig {
  const out: PartialConfig = {}
  if (typeof input.url === "string" && input.url.trim()) out.url = input.url.trim()
  if (typeof input.password === "string" && input.password) out.password = input.password
  if (typeof input.defaultDirectory === "string" && path.isAbsolute(input.defaultDirectory)) {
    out.defaultDirectory = input.defaultDirectory
  }
  if (Array.isArray(input.allowedRoots)) {
    out.allowedRoots = input.allowedRoots.filter((root) => typeof root === "string" && path.isAbsolute(root))
  }
  if (input.permissionProfile && PROFILE_VALUES.includes(input.permissionProfile)) {
    out.permissionProfile = input.permissionProfile
  }
  if (!out.url && input.url) log.warn(`Ignoring invalid url in ${origin}`)
  return out
}

function fromEnv(): PartialConfig {
  const out: PartialConfig = {}
  if (process.env[ENV_URL]) out.url = process.env[ENV_URL]!.trim()
  if (process.env[ENV_PASSWORD]) out.password = process.env[ENV_PASSWORD]!
  if (process.env.OPENCODE_MCP_DIRECTORY) out.defaultDirectory = process.env.OPENCODE_MCP_DIRECTORY
  if (process.env.OPENCODE_MCP_ALLOWED_ROOTS) {
    out.allowedRoots = process.env.OPENCODE_MCP_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean)
  }
  const profile = process.env.OPENCODE_MCP_PERMISSION_PROFILE as PermissionProfile | undefined
  if (profile && PROFILE_VALUES.includes(profile)) out.permissionProfile = profile
  return out
}

/** Precedence: runtime (tool) → env → config file. Returns null when incomplete. */
export async function resolveConfig(): Promise<BridgeConfig | null> {
  const file = (await readFileConfig()) ?? {}
  const merged: PartialConfig = { ...file, ...fromEnv(), ...runtime }

  const password = merged.password
  if (password) registerSecret(password)

  if (!merged.url || !password) return null

  let url: string
  try {
    url = normalizeUrl(merged.url)
  } catch {
    return null
  }

  return {
    url,
    password,
    defaultDirectory: merged.defaultDirectory,
    allowedRoots: merged.allowedRoots,
    permissionProfile: merged.permissionProfile ?? "workspace-write",
  }
}

export interface ConfigProvenance {
  url: { value?: string; source: "runtime" | "env" | "file" | "none" }
  password: { present: boolean; source: "runtime" | "env" | "file" | "none" }
}

/** Where each value came from, for opencode_status diagnostics (never returns the password). */
export async function describeConfig(): Promise<ConfigProvenance> {
  const file = (await readFileConfig()) ?? {}
  const env = fromEnv()
  const url = runtime.url ?? env.url ?? file.url
  const urlSource = runtime.url ? "runtime" : env.url ? "env" : file.url ? "file" : "none"
  const passwordSource = runtime.password ? "runtime" : env.password ? "env" : file.password ? "file" : "none"
  return {
    url: { value: url, source: urlSource },
    password: { present: passwordSource !== "none", source: passwordSource },
  }
}

export async function saveConfigFile(partial: PartialConfig): Promise<void> {
  const file = configPath()
  const existing = (await readFileConfig()) ?? {}
  const next: PartialConfig = { ...existing }
  for (const [key, value] of Object.entries(partial) as [keyof PartialConfig, unknown][]) {
    if (value === undefined) continue
    ;(next as Record<string, unknown>)[key] = value
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(tmp, file)
  await fs.chmod(file, 0o600).catch(() => undefined)
  log.info(`Configuration written to ${file}`)
}

export async function removeConfigFile(): Promise<void> {
  await fs.rm(configPath(), { force: true })
}

/** Header used by the OpenCode v2 server: HTTP Basic, username fixed to "opencode". */
export function authHeader(password: string): string {
  return "Basic " + Buffer.from(`${USERNAME}:${password}`).toString("base64")
}
