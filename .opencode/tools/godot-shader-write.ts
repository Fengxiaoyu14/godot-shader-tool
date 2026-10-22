import { tool } from "@opencode-ai/plugin"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"

import { GodotReaderError, toPublicError } from "./godot_shader_reader/errors.ts"
import { writeGodotShaderFile } from "./godot_shader_reader/file-writer.ts"
import { resolveInputPath } from "./godot_shader_reader/input-path.ts"

export default tool({
  description:
    "Replace complete Godot 3.5/3.6 and 4.x Shader code in embedded materials or standalone Shader files. " +
    "For external references, writes the actual shared Shader file and leaves the material unchanged; " +
    "all materials sharing that Shader see the change. Returns written_path. Requires official Godot version-matched " +
    "pre/post validation, exact read-back, non-code preservation and safe replacement.",
  args: {
    path: tool.schema
      .string()
      .describe("Absolute path or current-worktree-relative path to an Godot 3.5/3.6 and 4.x material or standalone Shader file"),
    shader_code: tool.schema.string().describe("Complete replacement Shader.code; preserved exactly without formatting"),
    project_root: tool.schema.string().optional().describe("Godot project root for res:// Shader references"),
    shader_path: tool.schema.string().optional().describe("Explicit external Shader file override; this file will be modified"),
    expected_hash: tool.schema.string().optional().describe("Require this SHA-256 source hash before writing"),
    dry_run: tool.schema.boolean().optional().describe("Validate and return diff without replacing the original"),
    godot_version: tool.schema.string().optional().describe("Validator profile, auto-detected for resources; set 4.x for Godot 4 raw source"),
    renderer: tool.schema.string().optional().describe("Validator renderer, gles3 for Godot 3.6, dummy for Godot 4"),
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

      const result = await writeGodotShaderFile(resolved, args.shader_code, {
        expectedHash: args.expected_hash,
        dryRun: args.dry_run,
        godotVersion: args.godot_version, renderer: args.renderer,
        ...(args.project_root === undefined ? {} : { projectRoot: resolveInputPath(args.project_root, context.worktree) }),
        ...(args.shader_path === undefined ? {} : { shaderPath: resolveInputPath(args.shader_path, context.worktree) }),
      })
      return JSON.stringify({ success: true, path: resolved.split(path.sep).join("/"), ...result }, null, 2)
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: toPublicError(error),
        ...(originalIsKnownPreserved(error) ? { original_preserved: true } : {}),
      }, null, 2)
    }
  },
})

function originalIsKnownPreserved(error: unknown): boolean {
  return error instanceof GodotReaderError && (
    error.code === "SHADER_VALIDATION_FAILED" ||
    error.code === "SHADER_VALIDATOR_UNAVAILABLE" ||
    error.code === "SHADER_VALIDATOR_FAILED" ||
    error.code === "SHADER_VALIDATOR_TIMEOUT" ||
    error.code === "INVALID_VALIDATOR_RESPONSE"
  )
}

function failure(code: "FILE_NOT_FOUND", message: string): string {
  return JSON.stringify({ success: false, error: { code, message } }, null, 2)
}
