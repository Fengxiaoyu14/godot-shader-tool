#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, "../..")
const validator = process.argv[2] ?? path.join(
  repositoryRoot,
  ".opencode/tools/bin/linux-x64/godot-shader-validator",
)
const shaderDirectory = path.join(testDirectory, "shaders")

const cases = [
  ["valid-spatial.gdshader", 0, true, "spatial"],
  ["instance-custom.gdshader", 0, true, "spatial"],
  ["render-modes.gdshader", 0, true, "spatial"],
  ["gles3-uint-uvec.gdshader", 0, true, "spatial"],
  ["gles3-array.gdshader", 0, true, "spatial"],
  ["gles3-switch.gdshader", 0, true, "spatial"],
  ["valid-canvas-item.gdshader", 0, true, "canvas_item"],
  ["valid-particles.gdshader", 0, true, "particles"],
  ["syntax-error.gdshader", 1, false, "spatial"],
  ["unknown-identifier.gdshader", 1, false, "spatial"],
  ["invalid-render-mode.gdshader", 1, false, "spatial"],
]

for (const [fixture, expectedExit, expectedValidity, expectedType] of cases) {
  const completed = spawnSync(validator, ["--file", path.join(shaderDirectory, fixture)], {
    encoding: "utf8",
  })
  assert.equal(completed.status, expectedExit, `${fixture}: ${completed.stderr}`)
  assert.equal(completed.stderr, "", `${fixture}: stderr must stay empty`)
  const result = JSON.parse(completed.stdout)
  assert.equal(result.valid, expectedValidity, fixture)
  assert.equal(result.godot_version, "3.6", fixture)
  assert.equal(result.renderer, "gles3", fixture)
  assert.equal(result.shader_type, expectedType, fixture)
  if (!expectedValidity) {
    assert.ok(Number.isInteger(result.error?.line) && result.error.line > 0, fixture)
    assert.ok(typeof result.error?.message === "string" && result.error.message.length > 0, fixture)
  }
}

const stdinSource = "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(1.0); }\n"
const stdinResult = spawnSync(validator, ["--stdin"], { input: stdinSource, encoding: "utf8" })
assert.equal(stdinResult.status, 0)
assert.equal(stdinResult.stderr, "")
assert.equal(JSON.parse(stdinResult.stdout).valid, true)

const missingInput = spawnSync(validator, [], { encoding: "utf8" })
assert.equal(missingInput.status, 3)
assert.equal(missingInput.stderr, "")
assert.equal(JSON.parse(missingInput.stdout).internal_error.code, "VALIDATOR_INPUT_ERROR")

process.stdout.write(`validator CLI: ${cases.length + 2} checks passed\n`)
