import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { invalidInput } from "../errors.js"
import { assertWritable, openClient, register, workspaceFor, type ServerContext } from "./shared.js"
import { executePrompt, guessMime } from "./prompt.js"

const MAX_BYTES = 10 * 1024 * 1024

export function registerFileTools(server: McpServer, ctx: ServerContext): void {
  register(
    server,
    "opencode_file_attach",
    {
      title: "Attach a file to a session",
      description:
        "Upload a file into a session. Provide `path` (server-side file) or `data` (base64 bytes). " +
        "When `text` is supplied the file is sent immediately as a prompt and the answer is returned; " +
        "otherwise the attachment descriptor and stored path are returned for a later prompt.",
      inputSchema: {
        sessionID: z.string(),
        path: z.string().optional().describe("Absolute or workspace-relative path"),
        data: z.string().optional().describe("Base64-encoded file contents"),
        name: z.string().optional(),
        mime: z.string().optional(),
        description: z.string().optional(),
        text: z.string().optional().describe("Also send this prompt with the attachment"),
        wait: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      assertWritable(ctx, "uploading files")
      if (!args.path && !args.data) throw invalidInput("Provide path or data.")

      const { client } = await openClient(ctx)
      const session = await client.session.get({ sessionID: args.sessionID })
      const directory = session.location?.directory ?? (await workspaceFor(ctx)).directory

      let storedPath: string | undefined
      let bytes: Buffer
      let name = args.name

      if (args.data) {
        bytes = Buffer.from(args.data, "base64")
        if (bytes.byteLength > MAX_BYTES) throw invalidInput("File is larger than 10 MB.")
        name = name ?? `attachment-${Date.now()}.bin`
        const safeName = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, "_")
        const dir = path.join(directory, ".opencode", "attachments")
        await fs.mkdir(dir, { recursive: true })
        storedPath = path.join(dir, safeName)
        await fs.writeFile(storedPath, bytes)
      } else {
        const absolute = path.isAbsolute(args.path!) ? args.path! : path.resolve(directory, args.path!)
        const stat = await fs.stat(absolute).catch(() => null)
        if (!stat?.isFile()) throw invalidInput(`File not found: ${absolute}`)
        if (stat.size > MAX_BYTES) throw invalidInput(`File is larger than 10 MB: ${absolute}`)
        bytes = await fs.readFile(absolute)
        name = name ?? path.basename(absolute)
        storedPath = absolute
      }

      const mime = args.mime ?? guessMime(storedPath ?? name ?? "")
      const attachment = {
        uri: `data:${mime};base64,${bytes.toString("base64")}`,
        name,
        description: args.description,
        source: { type: "inline" as const },
      }

      if (args.text) {
        const result = await executePrompt(ctx, {
          sessionID: args.sessionID,
          text: args.text,
          files: [{ path: storedPath, name, description: args.description }],
          wait: args.wait,
        })
        return { ok: true, storedPath, attachment: { name, mime, size: bytes.byteLength }, result }
      }

      return {
        ok: true,
        storedPath,
        attachment: {
          name,
          mime,
          size: bytes.byteLength,
          uriPreview: `data:${mime};base64,… (${bytes.byteLength} bytes)`,
        },
        hint: "Pass storedPath to opencode_session_prompt.files or call opencode_file_attach again with text.",
      }
    },
  )
}
