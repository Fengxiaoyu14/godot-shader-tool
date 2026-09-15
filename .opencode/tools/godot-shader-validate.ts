import { tool } from "@opencode-ai/plugin"

import { toPublicError } from "./godot_shader_reader/errors.ts"
import { validateShaderRequest } from "./godot_shader_reader/validation-tool.ts"

export default tool({
  description:
    "Validate Godot 3.6 GLES3 shader source using the official Godot ShaderLanguage parser and ShaderTypes " +
    "definitions. Accept either shader_code or a material/Shader file path (including external Shader references), is read-only, and checks syntax, " +
    "types, built-ins, and render modes without starting Godot or a GPU.",
  args: {
    shader_code: tool.schema.string().optional().describe("Complete Godot 3.6 shader source to validate"),
    path: tool.schema
      .string()
      .optional()
      .describe("Absolute or current-worktree-relative path to a Godot 3.5/3.6 material or Shader file"),
    project_root: tool.schema.string().optional().describe("Godot project root for res:// paths; auto-detected if omitted"),
    shader_path: tool.schema.string().optional().describe("Explicit external Shader file override for path input"),
  },
  async execute(args, context) {
    try {
      return JSON.stringify(await validateShaderRequest(args, context.worktree), null, 2)
    } catch (error) {
      return JSON.stringify({ valid: false, internal_error: toPublicError(error) }, null, 2)
    }
  },
})
