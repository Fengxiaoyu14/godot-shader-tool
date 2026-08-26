import { tool } from "@opencode-ai/plugin"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

import { readGodot36Shader, toPublicError } from "./godot_shader_reader/index.ts"

export default tool({
  description:
    "Read the complete Shader.code embedded in a Godot 3.6 binary ShaderMaterial (.material/.res). " +
    "Use this for binary materials that cannot be meaningfully read as text. " +
    "The tool supports RSCC/ZSTD and RSRC, returns resource metadata, and is strictly read-only.",
  args: {
    path: tool.schema.string().describe("Project-relative path to a Godot 3.6 .material or .res file"),
  },
  async execute(args, context) {
    try {
      const worktree = await realpath(context.worktree)
      const requested = path.resolve(worktree, args.path)
      if (!isInside(worktree, requested)) {
        return failure("PATH_OUTSIDE_WORKTREE", "The requested path is outside the current git worktree")
      }

      let resolved: string
      try {
        resolved = await realpath(requested)
      } catch {
        return failure("FILE_NOT_FOUND", `File not found: ${args.path}`)
      }
      if (!isInside(worktree, resolved)) {
        return failure("PATH_OUTSIDE_WORKTREE", "The resolved file is outside the current git worktree")
      }

      const fileStat = await stat(resolved)
      if (!fileStat.isFile()) {
        return failure("FILE_NOT_FOUND", `Not a regular file: ${args.path}`)
      }

      const bytes = await readFile(resolved)
      const result = readGodot36Shader(bytes)
      const relativePath = path.relative(worktree, resolved).split(path.sep).join("/")
      return JSON.stringify({ success: true, path: relativePath, ...result }, null, 2)
    } catch (error) {
      return JSON.stringify({ success: false, error: toPublicError(error) }, null, 2)
    }
  },
})

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function failure(code: "FILE_NOT_FOUND" | "PATH_OUTSIDE_WORKTREE", message: string): string {
  return JSON.stringify({ success: false, error: { code, message } }, null, 2)
}
