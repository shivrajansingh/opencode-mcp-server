import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { log } from "./log.js"

export const OPENCODE_SERVICE_PATHS = [
  path.join(os.homedir(), ".local", "state", "opencode", "service.json"),
  path.join(os.homedir(), ".config", "opencode", "service.json"),
]

export interface DiscoveredService {
  url: string
  password: string
}

/**
 * Development convenience for `--discover`. Reads the local OpenCode service registration.
 * Never used unless the flag is passed explicitly.
 */
export async function readServiceFile(): Promise<DiscoveredService | null> {
  for (const file of OPENCODE_SERVICE_PATHS) {
    try {
      const raw = await fs.readFile(file, "utf8")
      const parsed = JSON.parse(raw) as { url?: string; port?: number; password?: string }
      if (!parsed.password) continue
      const url = parsed.url ?? (parsed.port ? `http://127.0.0.1:${parsed.port}` : undefined)
      if (!url) continue
      return { url, password: parsed.password }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") log.debug(`Could not read ${file}`, { code })
    }
  }
  return null
}
