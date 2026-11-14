import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertWithinAllowedRoots, resolveWorkspace } from "../src/workspace.js"

let root: string
let other: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ocmcp-root-"))
  other = await fs.mkdtemp(path.join(os.tmpdir(), "ocmcp-other-"))
  await fs.mkdir(path.join(root, "repo"), { recursive: true })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(other, { recursive: true, force: true })
})

describe("resolveWorkspace", () => {
  it("prefers an explicit absolute directory", async () => {
    const result = await resolveWorkspace({ directory: path.join(root, "repo") })
    expect(result.source).toBe("argument")
    expect(result.directory.endsWith("repo")).toBe(true)
  })

  it("resolves a relative directory against the config default", async () => {
    const result = await resolveWorkspace({
      directory: "repo",
      config: { url: "http://127.0.0.1:1", password: "x", defaultDirectory: root, permissionProfile: "workspace-write" },
    })
    expect(result.directory).toBe(path.join(root, "repo"))
    expect(result.source).toBe("argument")
  })

  it("rejects a missing directory", async () => {
    await expect(resolveWorkspace({ directory: path.join(root, "nope") })).rejects.toThrow(/does not exist/)
  })

  it("uses MCP roots before env hints", async () => {
    process.env.CLAUDE_PROJECT_DIR = other
    try {
      const result = await resolveWorkspace({
        roots: async () => [`file://${path.join(root, "repo")}`],
      })
      expect(result.source).toBe("roots")
      expect(result.directory).toBe(path.join(root, "repo"))
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR
    }
  })

  it("falls back to env hints", async () => {
    process.env.CLAUDE_PROJECT_DIR = path.join(root, "repo")
    try {
      const result = await resolveWorkspace()
      expect(result.source).toBe("env")
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR
    }
  })

  it("refuses the home directory as a silent fallback", async () => {
    const cwd = process.cwd()
    const saved = { INIT_CWD: process.env.INIT_CWD, OPENCODE_MCP_DIRECTORY: process.env.OPENCODE_MCP_DIRECTORY }
    delete process.env.INIT_CWD
    delete process.env.OPENCODE_MCP_DIRECTORY
    process.chdir(os.homedir())
    try {
      await expect(resolveWorkspace()).rejects.toThrow(/Cannot determine which directory/)
    } finally {
      process.chdir(cwd)
      if (saved.INIT_CWD !== undefined) process.env.INIT_CWD = saved.INIT_CWD
      if (saved.OPENCODE_MCP_DIRECTORY !== undefined) process.env.OPENCODE_MCP_DIRECTORY = saved.OPENCODE_MCP_DIRECTORY
    }
  })
})

describe("assertWithinAllowedRoots", () => {
  it("allows a nested directory", async () => {
    await expect(assertWithinAllowedRoots(path.join(root, "repo"), [root])).resolves.toBeUndefined()
  })

  it("rejects outside paths", async () => {
    await expect(assertWithinAllowedRoots(other, [root])).rejects.toThrow(/outside the allowed roots/)
  })

  it("rejects traversal that escapes the root", async () => {
    await expect(assertWithinAllowedRoots(path.join(root, "..", path.basename(other)), [root])).rejects.toThrow(
      /outside the allowed roots/,
    )
  })

  it("is a no-op without a allowlist", async () => {
    await expect(assertWithinAllowedRoots(other, undefined)).resolves.toBeUndefined()
  })
})
