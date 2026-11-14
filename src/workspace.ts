import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { BridgeConfig } from "./config.js"
import { BridgeError, invalidInput } from "./errors.js"
import { log } from "./log.js"

export type WorkspaceSource = "argument" | "roots" | "env" | "config" | "cwd"

export interface WorkspaceResult {
  directory: string
  source: WorkspaceSource
}

export interface ResolveWorkspaceOptions {
  /** Explicit tool argument. */
  directory?: string
  config?: BridgeConfig | null
  /** MCP roots/list provider (may throw when unsupported). */
  roots?: () => Promise<string[]>
}

const ENV_HINTS = ["CLAUDE_PROJECT_DIR", "OPENCODE_MCP_DIRECTORY", "INIT_CWD"]

let rootsCache: { at: number; roots: string[] } | null = null
const ROOTS_TTL_MS = 5_000

export function invalidateRoots(): void {
  rootsCache = null
}

async function readRoots(provider?: () => Promise<string[]>): Promise<string[]> {
  if (!provider) return []
  if (rootsCache && Date.now() - rootsCache.at < ROOTS_TTL_MS) return rootsCache.roots
  try {
    const uris = await provider()
    const roots = uris.map(uriToDirectory).filter((value): value is string => Boolean(value))
    rootsCache = { at: Date.now(), roots }
    return roots
  } catch (error) {
    log.debug("roots/list unavailable", { error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

function uriToDirectory(uri: string): string | null {
  if (!uri.startsWith("file://")) return null
  try {
    const url = new URL(uri)
    if (url.hostname && url.hostname !== "localhost") return null
    return decodeURIComponent(url.pathname)
  } catch {
    return null
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

function isUselessDirectory(candidate: string): boolean {
  const resolved = path.resolve(candidate)
  return resolved === path.parse(resolved).root || resolved === os.homedir()
}

/**
 * Resolve the workspace the session should be created in.
 * Order: explicit argument → MCP roots → env hints → config.defaultDirectory → cwd.
 */
export async function resolveWorkspace(options: ResolveWorkspaceOptions = {}): Promise<WorkspaceResult> {
  const base = options.config?.defaultDirectory ?? process.cwd()

  if (options.directory) {
    const candidate = path.isAbsolute(options.directory)
      ? options.directory
      : path.resolve(base, options.directory)
    if (!(await isDirectory(candidate))) {
      throw invalidInput(`Workspace directory does not exist: ${candidate}`)
    }
    return { directory: await realpath(candidate), source: "argument" }
  }

  for (const root of await readRoots(options.roots)) {
    if (await isDirectory(root)) return { directory: await realpath(root), source: "roots" }
  }

  for (const name of ENV_HINTS) {
    const value = process.env[name]
    if (value && path.isAbsolute(value) && (await isDirectory(value))) {
      return { directory: await realpath(value), source: "env" }
    }
  }

  if (options.config?.defaultDirectory) {
    if (await isDirectory(options.config.defaultDirectory)) {
      return { directory: await realpath(options.config.defaultDirectory), source: "config" }
    }
    log.warn(`Configured defaultDirectory does not exist: ${options.config.defaultDirectory}`)
  }

  const cwd = process.cwd()
  if (!isUselessDirectory(cwd) && (await isDirectory(cwd))) {
    return { directory: await realpath(cwd), source: "cwd" }
  }

  throw new BridgeError("INVALID_INPUT", "Cannot determine which directory to work in.", {
    hint:
      "Pass `directory` (absolute path) to the tool, set OPENCODE_MCP_DIRECTORY, or configure a defaultDirectory. " +
      `The bridge refuses to fall back to ${cwd} because it is the home or filesystem root.`,
  })
}

/** Reject directories outside the configured allowlist (symlink-safe). */
export async function assertWithinAllowedRoots(directory: string, allowedRoots?: string[]): Promise<void> {
  if (!allowedRoots || allowedRoots.length === 0) return
  const target = await realpath(directory)
  for (const root of allowedRoots) {
    const resolvedRoot = await realpath(root)
    const relative = path.relative(resolvedRoot, target)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return
  }
  throw new BridgeError("PATH_NOT_ALLOWED", `Directory is outside the allowed roots: ${target}`, {
    hint: `Allowed roots: ${allowedRoots.join(", ")}. Update OPENCODE_MCP_ALLOWED_ROOTS to permit this path.`,
  })
}

async function realpath(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate)
  } catch {
    return path.resolve(candidate)
  }
}
