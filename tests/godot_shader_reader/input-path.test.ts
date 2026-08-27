import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { resolveInputPath } from "../../.opencode/tools/godot_shader_reader/input-path.ts"

test("absolute input paths are independent of the OpenCode worktree", () => {
  const absolute = path.resolve("outside", "example.material")
  const unrelatedWorktree = path.resolve("temporary-opencode-worktree")

  assert.equal(resolveInputPath(absolute, unrelatedWorktree), path.normalize(absolute))
})

test("relative input paths are resolved from the OpenCode worktree", () => {
  const worktree = path.resolve("project")

  assert.equal(resolveInputPath("assets/example.material", worktree), path.resolve(worktree, "assets/example.material"))
})
