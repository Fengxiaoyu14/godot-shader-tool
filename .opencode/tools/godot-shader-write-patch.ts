import { tool } from "@opencode-ai/plugin"
import { patchGodotShaderFile } from "./godot_shader_reader/file-writer.ts"
import { parsePatchOps } from "./godot_shader_reader/patch.ts"
import { resolveInputPath } from "./godot_shader_reader/input-path.ts"
import { toPublicError } from "./godot_shader_reader/errors.ts"

export default tool({
  description: "Apply literal, count-asserted Shader patches internally without transferring full source. All ops succeed or no write occurs. External references modify the shared Shader. Mandatory official pre/post validation and read-back; returns hashes and unified diff.",
  args: {
    path: tool.schema.string().describe("Material or standalone Shader path"),
    ops: tool.schema.array(tool.schema.union([
      tool.schema.object({ find: tool.schema.string(), replace: tool.schema.string(), expect: tool.schema.number().int().positive() }).strict(),
      tool.schema.object({ delete_lines: tool.schema.tuple([tool.schema.number().int().positive(), tool.schema.number().int().positive()]), expected_text: tool.schema.string(), expect: tool.schema.literal(1) }).strict(),
    ])).describe("Sequential operations; delete_lines uses current 1-based inclusive lines and requires exact expected_text including line endings"),
    expected_hash: tool.schema.string().optional().describe("Expected SHA-256 of full decoded source"),
    project_root: tool.schema.string().optional(),
    shader_path: tool.schema.string().optional(),
    dry_run: tool.schema.boolean().optional().describe("Validate temp read-back and return diff; do not replace original"),
    godot_version: tool.schema.string().optional().describe("Validator profile, default 3.6"),
    renderer: tool.schema.string().optional().describe("Validator renderer, default gles3"),
  },
  async execute(args, context) {
    try {
      const target = resolveInputPath(args.path, context.worktree)
      const result = await patchGodotShaderFile(target, parsePatchOps(args.ops), {
        expectedHash: args.expected_hash, dryRun: args.dry_run,
        godotVersion: args.godot_version, renderer: args.renderer,
        ...(args.project_root === undefined ? {} : { projectRoot: resolveInputPath(args.project_root, context.worktree) }),
        ...(args.shader_path === undefined ? {} : { shaderPath: resolveInputPath(args.shader_path, context.worktree) }),
      })
      return JSON.stringify({ success: true, path: target, ...result }, null, 2)
    } catch (error) { return JSON.stringify({ success: false, error: toPublicError(error) }, null, 2) }
  },
})
