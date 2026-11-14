import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  authHeader,
  clearRuntimeConfig,
  isPrivateHost,
  normalizeUrl,
  resolveConfig,
  setRuntimeConfig,
} from "../src/config.js"

let dir: string
let configFile: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ocmcp-config-"))
  configFile = path.join(dir, "config.json")
  process.env.OPENCODE_MCP_CONFIG = configFile
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.OPENCODE_MCP_CONFIG
})

beforeEach(async () => {
  clearRuntimeConfig()
  delete process.env.OPENCODE_URL
  delete process.env.OPENCODE_PASSWORD
  delete process.env.OPENCODE_MCP_DIRECTORY
  await fs.rm(configFile, { force: true })
})

describe("normalizeUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeUrl("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096")
    expect(normalizeUrl("http://127.0.0.1:4096///")).toBe("http://127.0.0.1:4096")
  })

  it("keeps a path prefix", () => {
    expect(normalizeUrl("https://example.test/opencode/")).toBe("https://example.test/opencode")
  })

  it("rejects non-http protocols and garbage", () => {
    expect(() => normalizeUrl("ftp://example.test")).toThrow(/protocol/i)
    expect(() => normalizeUrl("not a url")).toThrow(/valid URL/i)
  })
})

describe("isPrivateHost", () => {
  it("accepts loopback and RFC1918", () => {
    for (const url of [
      "http://127.0.0.1:4096",
      "http://localhost:4096",
      "http://10.1.2.3",
      "http://192.168.0.10",
      "http://172.16.4.2",
      "http://[::1]:4096",
    ]) {
      expect(isPrivateHost(url), url).toBe(true)
    }
  })

  it("rejects public hosts", () => {
    expect(isPrivateHost("http://8.8.8.8")).toBe(false)
    expect(isPrivateHost("https://opencode.example.com")).toBe(false)
    expect(isPrivateHost("http://172.32.0.1")).toBe(false)
  })
})

describe("resolveConfig precedence", () => {
  it("returns null when incomplete", async () => {
    process.env.OPENCODE_URL = "http://127.0.0.1:4096"
    expect(await resolveConfig()).toBeNull()
  })

  it("reads env values", async () => {
    process.env.OPENCODE_URL = "http://127.0.0.1:4096"
    process.env.OPENCODE_PASSWORD = "env-pass"
    const config = await resolveConfig()
    expect(config?.url).toBe("http://127.0.0.1:4096")
    expect(config?.password).toBe("env-pass")
    expect(config?.permissionProfile).toBe("workspace-write")
  })

  it("runtime beats env", async () => {
    process.env.OPENCODE_URL = "http://127.0.0.1:4096"
    process.env.OPENCODE_PASSWORD = "env-pass"
    setRuntimeConfig({ password: "runtime-pass" })
    expect((await resolveConfig())?.password).toBe("runtime-pass")
  })

  it("env beats file", async () => {
    await fs.writeFile(configFile, JSON.stringify({ url: "http://10.0.0.1:4096", password: "file-pass" }))
    process.env.OPENCODE_PASSWORD = "env-pass"
    const config = await resolveConfig()
    expect(config?.url).toBe("http://10.0.0.1:4096")
    expect(config?.password).toBe("env-pass")
  })

  it("falls back to the file", async () => {
    await fs.writeFile(configFile, JSON.stringify({ url: "http://10.0.0.1:4096/", password: "file-pass" }))
    const config = await resolveConfig()
    expect(config?.url).toBe("http://10.0.0.1:4096")
    expect(config?.password).toBe("file-pass")
  })

  it("ignores a malformed file", async () => {
    await fs.writeFile(configFile, "{ not json")
    process.env.OPENCODE_URL = "http://127.0.0.1:4096"
    process.env.OPENCODE_PASSWORD = "env-pass"
    expect((await resolveConfig())?.password).toBe("env-pass")
  })
})

describe("authHeader", () => {
  it("uses basic auth with the fixed opencode username", () => {
    const header = authHeader("secret")
    expect(header).toBe("Basic " + Buffer.from("opencode:secret").toString("base64"))
  })
})
