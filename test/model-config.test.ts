import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assignModel, modelConfigValue, projectConfigFile, writeConfigValue } from "../src/model-config.js"

let dir: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ocmcp-model-"))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("modelConfigValue", () => {
  it("maps API refs to config shape", () => {
    expect(modelConfigValue({ providerID: "opencode", id: "iceman-free" })).toEqual({
      providerID: "opencode",
      model: "iceman-free",
    })
    expect(modelConfigValue({ providerID: "p", id: "m", variant: "high" })).toEqual({
      providerID: "p",
      model: "m",
      variant: "high",
    })
  })
})

describe("writeConfigValue", () => {
  it("creates a file with the value", async () => {
    const file = path.join(dir, "fresh.json")
    await writeConfigValue(file, ["model"], { providerID: "p", model: "m" })
    const parsed = JSON.parse(await fs.readFile(file, "utf8"))
    expect(parsed.model).toEqual({ providerID: "p", model: "m" })
  })

  it("preserves comments and unrelated keys", async () => {
    const file = path.join(dir, "commented.jsonc")
    await fs.writeFile(
      file,
      `{
  // this comment must survive
  "shell": "bash",
  "model": "old/one"
}
`,
    )
    await writeConfigValue(file, ["model"], { providerID: "p", model: "new" })
    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("// this comment must survive")
    expect(text).toContain('"shell": "bash"')
    expect(text).not.toContain("old/one")
  })

  it("nests agent models", async () => {
    const file = path.join(dir, "agent.json")
    await writeConfigValue(file, ["agents", "build", "model"], { providerID: "p", model: "m" })
    const parsed = JSON.parse(await fs.readFile(file, "utf8"))
    expect(parsed.agents.build.model).toEqual({ providerID: "p", model: "m" })
  })
})

describe("projectConfigFile", () => {
  it("prefers an existing project config", async () => {
    const project = path.join(dir, "project")
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(project, "opencode.jsonc"), "{}")
    expect(await projectConfigFile(project)).toBe(path.join(project, "opencode.jsonc"))
  })

  it("defaults to opencode.json when none exists", async () => {
    const project = path.join(dir, "empty")
    await fs.mkdir(project, { recursive: true })
    expect(await projectConfigFile(project)).toBe(path.join(project, "opencode.json"))
  })
})

describe("assignModel", () => {
  it("writes a project model", async () => {
    const project = path.join(dir, "assign")
    await fs.mkdir(project, { recursive: true })
    const result = await assignModel({
      scope: "project",
      directory: project,
      model: { providerID: "opencode", id: "iceman-free" },
    })
    expect(result.keys).toEqual(["model"])
    const parsed = JSON.parse(await fs.readFile(result.file, "utf8"))
    expect(parsed.model).toEqual({ providerID: "opencode", model: "iceman-free" })
  })
})
