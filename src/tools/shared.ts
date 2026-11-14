import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OpenCodeClient } from "@opencode/client"
import type { BridgeConfig } from "../config.js"
import type { OpenCodeBridge } from "../client.js"
import { assertWithinAllowedRoots, resolveWorkspace, type WorkspaceResult } from "../workspace.js"
import { BridgeError, fail, ok } from "../errors.js"

export interface ServerContext {
  bridge: OpenCodeBridge
  rootsProvider: () => Promise<string[]>
  readOnly: boolean
  allowRemoteUrl: boolean
  /** Full history (raw tool inputs/outputs) is admin-only; off unless the bridge enables it. */
  allowFullHistory: boolean
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  [key: string]: unknown
}

export interface ToolDefinition {
  title: string
  description: string
  inputSchema?: Record<string, z.ZodType>
  annotations?: Record<string, unknown>
}

type Handler = (args: Record<string, any>, extra: unknown) => Promise<unknown>

/**
 * Register a tool with uniform error handling: handlers return plain data (serialized as JSON) or a
 * ToolResult, and every thrown error becomes a readable `isError` result the model can relay.
 */
export function register(server: McpServer, name: string, definition: ToolDefinition, handler: Handler): void {
  const callback = async (args: Record<string, any>, extra: unknown): Promise<ToolResult> => {
    try {
      const result = await handler(args ?? {}, extra)
      if (isToolResult(result)) return result
      return ok(result)
    } catch (error) {
      return fail(error)
    }
  }
  // The SDK's generic signature varies between 1.x minors; the runtime contract is stable.
  ;(server.registerTool as any)(name, definition, callback)
}

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === "object" && "content" in (value as Record<string, unknown>))
}

export async function currentConfig(ctx: ServerContext): Promise<BridgeConfig | null> {
  return ctx.bridge.configuration ?? (await ctx.bridge.reload())
}

/** Resolve the workspace for a call and enforce the allowlist. */
export async function workspaceFor(
  ctx: ServerContext,
  directory?: string,
): Promise<WorkspaceResult & { config: BridgeConfig | null }> {
  const config = await currentConfig(ctx)
  const workspace = await resolveWorkspace({ directory, config, roots: ctx.rootsProvider })
  await assertWithinAllowedRoots(workspace.directory, config?.allowedRoots)
  return { ...workspace, config }
}

export async function openClient(ctx: ServerContext): Promise<{ client: OpenCodeClient; config: BridgeConfig }> {
  const config = await ctx.bridge.configOrThrow()
  const client = await ctx.bridge.client()
  return { client, config }
}

/** Reject write-ish tools when the bridge runs in --read-only mode. */
export function assertWritable(ctx: ServerContext, what: string): void {
  if (ctx.readOnly) {
    throw new BridgeError("INVALID_INPUT", `The bridge is running in read-only mode; ${what} is disabled.`)
  }
}
