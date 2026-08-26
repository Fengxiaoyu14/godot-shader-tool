import { tool } from "@opencode-ai/plugin"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"

import { toPublicError } from "./godot_shader_reader/errors.ts"
import { writeGodotShaderFile } from "./godot_shader_reader/file-writer.ts"
import { resolveInputPath } from "./godot_shader_reader/input-path.ts"

export default tool({
  description:
    "Replace the complete Shader.code stored in an existing Godot 3.6 binary ShaderMaterial (.material/.res). " +
    "This is a write operation: it fully parses and reserializes the resource, writes a sibling temporary file, " +
    "reads it back, verifies that only Shader.code changed, and only then safely replaces the original file.",
  args: {
    path: tool.schema
      .string()
      .describe("Absolute path or current-worktree-relative path to an existing Godot 3.6 .material or .res file"),
    shader_code: tool.schema.string().describe("Complete replacement Shader.code; preserved exactly without formatting"),
  },
  async execute(args, context) {
    try {
      const requested = resolveInputPath(args.path, context.worktree)

      let resolved: string
      try {
        resolved = await realpath(requested)
      } catch {
        return failure("FILE_NOT_FOUND", `File not found: ${args.path}`)
      }
      const fileStat = await stat(resolved)
      if (!fileStat.isFile()) {
        return failure("FILE_NOT_FOUND", `Not a regular file: ${args.path}`)
      }

      const result = await writeGodotShaderFile(resolved, args.shader_code)
      return JSON.stringify({ success: true, path: resolved.split(path.sep).join("/"), ...result }, null, 2)
    } catch (error) {
      return JSON.stringify({ success: false, error: toPublicError(error) }, null, 2)
    }
  },
})

function failure(code: "FILE_NOT_FOUND", message: string): string {
  return JSON.stringify({ success: false, error: { code, message } }, null, 2)
}
