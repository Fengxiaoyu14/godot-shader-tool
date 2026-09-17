import { tool } from "@opencode-ai/plugin"
import { searchGodotShaders } from "./godot_shader_reader/search.ts"
import { resolveInputPath } from "./godot_shader_reader/input-path.ts"
import { toPublicError } from "./godot_shader_reader/errors.ts"

export default tool({
  description: "Read-only recursive Shader search using the shared material reader (including RSCC and external references). Returns matching lines, 1-based line numbers and full source SHA-256. Literal by default; regex uses per-line JavaScript syntax. Skips symlinks, .git, .godot, .import and node_modules. Unsupported/corrupt files are reported as errors; other files continue.",
  args: {
    pattern: tool.schema.string(),
    project_root: tool.schema.string(),
    regex: tool.schema.boolean().optional(),
    max_matches: tool.schema.number().int().positive().optional().describe("Response limit, default 200, at most 10000"),
    offset: tool.schema.number().int().optional().describe("Zero-based matching-line offset for pagination"),
  },
  async execute(args, context) {
    try { return JSON.stringify(await searchGodotShaders(args.pattern, resolveInputPath(args.project_root, context.worktree), args), null, 2) }
    catch (error) { return JSON.stringify({ success: false, error: toPublicError(error) }, null, 2) }
  },
})
