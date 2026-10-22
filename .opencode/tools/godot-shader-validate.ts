import { tool } from "@opencode-ai/plugin"

import { toPublicError } from "./godot_shader_reader/errors.ts"
import { validateShaderRequest } from "./godot_shader_reader/validation-tool.ts"

export default tool({
  description:
    "Validate Godot 3.6 GLES3 or Godot 4.x shader source using the official Godot ShaderLanguage parser and ShaderTypes " +
    "definitions. Accept either shader_code or a material/Shader file path (including external Shader references), is read-only, and checks syntax, " +
    "types, built-ins, and render modes. Godot 4 uses the installed headless engine (GODOT4_BIN), without a GPU.",
  args: {
    shader_code: tool.schema.string().optional().describe("Complete shader source; select godot_version=4.x for Godot 4"),
    path: tool.schema
      .string()
      .optional()
      .describe("Absolute or current-worktree-relative path to a Godot 3.5/3.6 and 4.x material or Shader file"),
    project_root: tool.schema.string().optional().describe("Godot project root for res:// paths; auto-detected if omitted"),
    shader_path: tool.schema.string().optional().describe("Explicit external Shader file override for path input"),
    godot_version: tool.schema.string().optional().describe("Validator profile, auto-detected for resources; 3.6 for direct source unless set to 4.x"),
    renderer: tool.schema.string().optional().describe("Validator renderer: gles3 for 3.6, dummy for 4.x"),
  },
  async execute(args, context) {
    try {
      return JSON.stringify(await validateShaderRequest(args, context.worktree), null, 2)
    } catch (error) {
      return JSON.stringify({ valid: false, internal_error: toPublicError(error) }, null, 2)
    }
  },
})
