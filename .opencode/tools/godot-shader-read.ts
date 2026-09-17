import { tool } from "@opencode-ai/plugin"

import { readGodotShaderFile, toPublicError } from "./godot_shader_reader/index.ts"
import { resolveInputPath } from "./godot_shader_reader/input-path.ts"
import { sourceView } from "./godot_shader_reader/source-info.ts"

export default tool({
  description:
    "Read complete Godot 3.5/3.6 shader source from binary ShaderMaterial resources, including external Shader " +
    "references, standalone binary/text Shader resources, or .shader/.gdshader source. " +
    "Resolves res:// via the nearest ancestor project.godot or project_root; shader_path overrides an external dependency. " +
    "Returns source provenance and resource metadata and is strictly read-only.",
  args: {
    path: tool.schema.string().describe("Absolute or current-worktree-relative material or Shader file path"),
    project_root: tool.schema.string().optional().describe("Godot project root for res:// paths; auto-detected from the material if omitted"),
    shader_path: tool.schema.string().optional().describe("Explicit external Shader file override, e.g. a separately uploaded or renamed dependency"),
    metadata_only: tool.schema.boolean().optional().describe("Omit source; return hash, lengths, lexical uniform/function index"),
    start_line: tool.schema.number().int().positive().optional().describe("First source line, 1-based and inclusive"),
    end_line: tool.schema.number().int().positive().optional().describe("Last source line, inclusive; hash always covers full source"),
  },
  async execute(args, context) {
    try {
      const result = await readGodotShaderFile(resolveInputPath(args.path, context.worktree), {
        ...(args.project_root === undefined ? {} : { projectRoot: resolveInputPath(args.project_root, context.worktree) }),
        ...(args.shader_path === undefined ? {} : { shaderPath: resolveInputPath(args.shader_path, context.worktree) }),
      })
      return JSON.stringify({ success: true, ...sourceView(result, args) }, null, 2)
    } catch (error) {
      return JSON.stringify({ success: false, error: toPublicError(error) }, null, 2)
    }
  },
})
