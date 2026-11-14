import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerContext } from "./shared.js"
import { registerConfigTools } from "./config.js"
import { registerSessionAdminTools, registerSessionTools } from "./session.js"
import { registerPromptTools } from "./prompt.js"
import { registerHistoryTools } from "./history.js"
import { registerModelTools } from "./model.js"
import { registerAgentTools } from "./agent.js"
import { registerTaskTools } from "./task.js"
import { registerJobTools } from "./job.js"
import { registerFileTools } from "./files.js"
import { registerMcpTools } from "./mcp.js"
import { registerPermissionTools } from "./permission.js"

export type ToolProfile = "full" | "minimal"

/**
 * full    → 19 tools
 * minimal → 10 tools (status, configure, workspace, session create/prompt/history, model, task, job, permission)
 */
export function registerTools(server: McpServer, ctx: ServerContext, profile: ToolProfile = "full"): string[] {
  registerConfigTools(server, ctx)
  registerSessionTools(server, ctx)
  registerPromptTools(server, ctx)
  registerHistoryTools(server, ctx)
  registerModelTools(server, ctx)
  registerPermissionTools(server, ctx)
  registerTaskTools(server, ctx)
  registerJobTools(server, ctx)

  if (profile === "full") {
    registerSessionAdminTools(server, ctx)
    registerAgentTools(server, ctx)
    registerFileTools(server, ctx)
    registerMcpTools(server, ctx)
  }

  const names = [
    "opencode_status",
    "opencode_configure",
    "opencode_workspace",
    "opencode_session_create",
    "opencode_session_prompt",
    "opencode_session_history",
    "opencode_model",
    "opencode_permission",
    "opencode_task",
    "opencode_job",
  ]
  if (profile === "full") {
    names.push(
      "opencode_session_list",
      "opencode_session_get",
      "opencode_session_move",
      "opencode_session_delete",
      "opencode_session_interrupt",
      "opencode_session_compact",
      "opencode_agent",
      "opencode_file_attach",
      "opencode_mcp",
    )
  }
  return names
}
