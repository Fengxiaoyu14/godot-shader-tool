import { tool } from "@opencode-ai/plugin"
import { diffGodotMaterials } from "./godot_shader_reader/material-diff.ts"
import { resolveInputPath } from "./godot_shader_reader/input-path.ts"
import { toPublicError } from "./godot_shader_reader/errors.ts"

export default tool({
  description: "Compare Godot material Shader code and parameter values/types, including resolved texture paths. Returns unified code diff and parameter difference rows; read-only.",
  args: {
    before: tool.schema.string(), after: tool.schema.string(),
    before_project_root: tool.schema.string().optional(), after_project_root: tool.schema.string().optional(),
    before_shader_path: tool.schema.string().optional(), after_shader_path: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const resolve = (p: string | undefined) => p === undefined ? undefined : resolveInputPath(p, context.worktree)
    try {
      const result = await diffGodotMaterials(resolve(args.before)!, resolve(args.after)!,
        { projectRoot: resolve(args.before_project_root), shaderPath: resolve(args.before_shader_path) },
        { projectRoot: resolve(args.after_project_root), shaderPath: resolve(args.after_shader_path) })
      return JSON.stringify({ success: true, ...result }, null, 2)
    } catch (error) { return JSON.stringify({ success: false, error: toPublicError(error) }, null, 2) }
  },
})
