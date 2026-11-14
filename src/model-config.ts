import { existsSync as fsExistsSync, promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyEdits, modify } from "jsonc-parser"
import { BridgeError } from "./errors.js"

export interface ModelTarget {
  providerID: string
  id: string
  variant?: string
}

export type ModelScope = "session" | "project" | "global" | "agent"

/** Config representation accepted by OpenCode v2: { providerID, model, variant? }. */
export function modelConfigValue(model: ModelTarget): { providerID: string; model: string; variant?: string } {
  return {
    providerID: model.providerID,
    model: model.id,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

export function globalConfigFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  const base = path.join(configHome, "opencode")
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(base, name)
    if (existsSync(candidate)) return candidate
  }
  return path.join(base, "opencode.json")
}

/** Prefer an existing project config; otherwise create ./opencode.json. */
export async function projectConfigFile(directory: string): Promise<string> {
  const candidates = [
    path.join(directory, "opencode.jsonc"),
    path.join(directory, "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    path.join(directory, ".opencode", "opencode.json"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return path.join(directory, "opencode.json")
}

export function existsSync(file: string): boolean {
  return fsExistsSync(file)
}

/**
 * Set a value in a JSONC config file while preserving comments and formatting.
 * Creates the file (and parent directory) when missing.
 */
export async function writeConfigValue(file: string, keys: string[], value: unknown): Promise<void> {
  let text = "{\n}\n"
  try {
    text = await fs.readFile(file, "utf8")
    if (!text.trim()) text = "{\n}\n"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      throw new BridgeError("INTERNAL", `Cannot read ${file}: ${(error as Error).message}`)
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
  }

  const edits = modify(text, keys, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })
  if (edits.length === 0) return
  const next = applyEdits(text, edits)
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, next, { mode: 0o600 })
  await fs.rename(temp, file)
}

/** Write `model` (or `agents.<id>.model`) into the chosen config file. */
export async function assignModel(options: {
  scope: Exclude<ModelScope, "session">
  model: ModelTarget
  directory?: string
  agent?: string
}): Promise<{ file: string; keys: string[]; value: unknown }> {
  const value = modelConfigValue(options.model)
  if (options.scope === "agent") {
    if (!options.agent) {
      throw new BridgeError("INVALID_INPUT", "scope=agent requires agent")
    }
    const file = options.directory ? await projectConfigFile(options.directory) : globalConfigFile()
    const keys = ["agents", options.agent, "model"]
    await writeConfigValue(file, keys, value)
    return { file, keys, value }
  }

  const file = options.scope === "global" ? globalConfigFile() : await projectConfigFile(options.directory ?? process.cwd())
  const keys = ["model"]
  await writeConfigValue(file, keys, value)
  return { file, keys, value }
}
