import { tool } from "@opencode-ai/plugin"
import { applyShaderPlan } from "./godot_shader_reader/batch.ts"
import { resolveInputPath } from "./godot_shader_reader/input-path.ts"
import { toPublicError } from "./godot_shader_reader/errors.ts"

export default tool({
  description: "Execute a JSON array [{path, ops, expected_hash?, project_root?, shader_path?, godot_version?, renderer?}] from one plan file. Paths inside the plan are relative to its directory. One tool permission covers the plan, including resolved shared external Shaders. Preflight rejects duplicate actual targets. Each file has its own validated transaction; failure does not stop subsequent files. Returns per-file status, hashes and diffs.",
  args: {
    plan_path: tool.schema.string().describe("Absolute or worktree-relative JSON plan path"),
    dry_run: tool.schema.boolean().optional().describe("Perform validation and diff generation for all entries without replacing originals"),
    godot_version: tool.schema.string().optional().describe("Default validator profile for the plan; each entry may override godot_version. Otherwise auto-detected per resource/project."),
    renderer: tool.schema.string().optional().describe("Default renderer for the plan; entries may override renderer: gles3 for 3.6, dummy for 4.x"),
  },
  async execute(args, context) {
    try {
      return JSON.stringify(await applyShaderPlan(resolveInputPath(args.plan_path, context.worktree), { dryRun: args.dry_run, godotVersion: args.godot_version, renderer: args.renderer }), null, 2)
    } catch (error) { return JSON.stringify({ success: false, error: toPublicError(error) }, null, 2) }
  },
})
