import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { PermissionProfile } from "../config.js"
import { assertWritable, openClient, register, workspaceFor, type ServerContext } from "./shared.js"

const PROFILES: Record<PermissionProfile, Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>> = {
  "danger-full-access": [{ action: "*", resource: "*", effect: "allow" }],
  "workspace-write": [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
  ],
  "read-only": [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "bash", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "*", resource: "*", effect: "allow" },
  ],
}

export function registerPermissionTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_permission",
    {
      title: "Permission requests",
      description:
        "Headless runs block when OpenCode asks for permission. Use action=list to see pending requests and " +
        "action=reply to approve or reject them. action=policy reports the bridge profile, or applies its ruleset " +
        "to a session (approximate: OpenCode evaluates rules in order, so profiles are best-effort).",
      inputSchema: {
        action: z.enum(["list", "reply", "policy"]),
        directory: z.string().optional(),
        sessionID: z.string().optional(),
        requestID: z.string().optional(),
        decision: z.enum(["once", "always", "reject"]).optional(),
        message: z.string().optional(),
        profile: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const workspace = await workspaceFor(ctx, args.directory)
      const { client, config } = await openClient(ctx)

      if (args.action === "list") {
        const response = await client.permission.request.list({ location: { directory: workspace.directory } })
        return {
          directory: workspace.directory,
          requests: response.data.map((request) => ({
            requestID: request.id,
            sessionID: request.sessionID,
            action: request.action,
            resources: request.resources,
            save: request.save,
            message: request.message,
          })),
        }
      }

      if (args.action === "reply") {
        assertWritable(ctx, "replying to permission requests")
        if (!args.requestID) throw new Error("action=reply requires requestID")
        if (!args.decision) throw new Error("action=reply requires decision")
        const sessionID = args.sessionID ?? (await findSessionForRequest(ctx, args.requestID))
        await client.permission.reply({
          sessionID,
          requestID: args.requestID,
          decision: args.decision,
          message: args.message,
        })
        return { ok: true, requestID: args.requestID, decision: args.decision }
      }

      const profile = (args.profile ?? config.permissionProfile) as PermissionProfile
      if (args.profile && args.sessionID) {
        assertWritable(ctx, "changing session permissions")
        await client.session.update({ sessionID: args.sessionID, permissions: PROFILES[profile] })
        return { ok: true, sessionID: args.sessionID, profile, permissions: PROFILES[profile] }
      }
      return {
        profile,
        permissions: PROFILES[profile],
        note: "Pass sessionID with profile to apply these rules to an existing session.",
      }
    },
  )
}

async function findSessionForRequest(ctx: ServerContext, requestID: string): Promise<string> {
  const { client } = await openClient(ctx)
  const response = await client.permission.request.list()
  const match = response.data.find((request) => request.id === requestID)
  if (!match) throw new Error(`No pending permission request with id ${requestID}`)
  return match.sessionID
}
