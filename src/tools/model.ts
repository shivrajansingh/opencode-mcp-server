import { z } from "zod"
import { promises as fs } from "node:fs"
import { parse } from "jsonc-parser"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { OpenCodeClient } from "@opencode/client"
import { invalidInput } from "../errors.js"
import { assignModel, globalConfigFile, projectConfigFile } from "../model-config.js"
import { assertWritable, openClient, register, workspaceFor, type ServerContext } from "./shared.js"

const modelRef = z.object({
  providerID: z.string(),
  id: z.string(),
  variant: z.string().optional(),
})

export function registerModelTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_model",
    {
      title: "Models",
      description:
        "List models, read the default, and assign models at four levels: " +
        "session (immediate API switch), project (opencode.json in the workspace), " +
        "global (~/.config/opencode/opencode.json), agent (agents.<id>.model). " +
        "Session assignment wins for that conversation; project/global change the default for new sessions. " +
        "Config edits preserve JSONC comments and are verified against model/default.",
      inputSchema: {
        action: z.enum(["list", "default", "set"]),
        directory: z.string().optional(),
        sessionID: z.string().optional().describe("For scope=session"),
        model: modelRef.optional().describe("Required for action=set"),
        type: z.enum(["chat", "decision", "image"]).optional().describe("Filter for action=list"),
        scope: z
          .enum(["session", "project", "global", "agent"])
          .optional()
          .describe("Default: session when sessionID is given, otherwise project"),
        agent: z.string().optional().describe("Agent id for scope=agent"),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory)
      const { client } = await openClient(ctx)

      if (args.action === "list") {
        const response = await client.model.list({
          location: { directory: workspace.directory },
          types: args.type ? [args.type] : undefined,
        })
        return {
          directory: workspace.directory,
          models: response.data.map((model) => ({
            providerID: model.providerID,
            id: model.modelID,
            name: model.name,
            type: model.type,
            family: model.family,
            status: model.status,
            variants: (model.variants ?? []).map((variant: any) => variant.id ?? variant.name ?? variant),
            capabilities: model.capabilities,
            cost: model.cost,
          })),
        }
      }

      if (args.action === "default") {
        const response = await client.model.default({ location: { directory: workspace.directory } })
        return {
          directory: workspace.directory,
          model: response.data
            ? { providerID: response.data.providerID, id: response.data.modelID, name: response.data.name }
            : null,
        }
      }

      if (!args.model) throw invalidInput("action=set requires a model { providerID, id }.")
      const scope = args.scope ?? (args.sessionID ? "session" : "project")

      if (scope === "session") {
        if (!args.sessionID) throw invalidInput("scope=session requires sessionID.")
        await client.session.switchModel({ sessionID: args.sessionID, model: args.model })
        const info = await client.session.get({ sessionID: args.sessionID }).catch(() => null)
        return { ok: true, scope, sessionID: args.sessionID, model: info?.model ?? args.model }
      }

      assertWritable(ctx, "changing the default model")
      if (scope === "agent" && !args.agent) throw invalidInput("scope=agent requires agent.")

      const written = await assignModel({
        scope,
        model: args.model,
        directory: workspace.directory,
        agent: args.agent,
      })

      const fileVerified = await verifyFileValue(written.file, written.keys, written.value)

      // A newly created config file is not picked up by the file watcher; ask the server to reload.
      if (scope !== "agent") {
        await client.location.reload().catch(() => undefined)
      }

      const runtime =
        scope === "agent"
          ? { verified: null as boolean | null, effective: null as unknown }
          : await verifyDefault(client, workspace.directory, args.model)

      return {
        ok: true,
        scope,
        agent: args.agent ?? null,
        file: written.file,
        keys: written.keys,
        value: written.value,
        fileVerified,
        runtimeVerified: runtime.verified,
        effectiveModel: runtime.effective,
        note:
          scope === "agent"
            ? "Written to the agent config. OpenCode does not expose the resolved per-agent model through the API, " +
              "so only the file write can be verified; the agent's model takes effect on its next run."
            : "Changes apply to new sessions. An explicit session model still takes precedence. " +
              "If runtimeVerified=false, a closer config file may override this value.",
      }
    },
  )
}

async function verifyDefault(
  client: OpenCodeClient,
  directory: string,
  expected: { providerID: string; id: string },
): Promise<{ verified: boolean; effective: unknown }> {
  let effective: any = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await client.model.default({ location: { directory } }).catch(() => null)
    effective = response?.data ?? null
    if (effective && effective.providerID === expected.providerID && effective.modelID === expected.id) {
      return { verified: true, effective: { providerID: effective.providerID, id: effective.modelID } }
    }
    await delay(400)
  }
  return {
    verified: false,
    effective: effective ? { providerID: effective.providerID, id: effective.modelID } : null,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function verifyFileValue(file: string, keys: string[], expected: unknown): Promise<boolean> {
  try {
    const text = await fs.readFile(file, "utf8")
    const data = parse(text)
    let current: any = data
    for (const key of keys) current = current?.[key]
    return JSON.stringify(current) === JSON.stringify(expected)
  } catch {
    return false
  }
}

export { globalConfigFile, projectConfigFile }
