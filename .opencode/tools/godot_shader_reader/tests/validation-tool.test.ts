import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { GodotReaderError } from "../errors.ts"
import { validateShaderRequest } from "../validation-tool.ts"
import type { ShaderValidator } from "../validator.ts"
import { minimalShaderMaterial } from "./fixture-builder.ts"

test("validation request accepts direct shader_code without touching a resource", async () => {
  const source = "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(0.5); }\n"
  let received = ""
  const validator: ShaderValidator = async (code) => {
    received = code
    return {
      valid: true,
      godot_version: "3.6",
      renderer: "gles3",
      shader_type: "spatial",
    }
  }

  const result = await validateShaderRequest({ shader_code: source }, "/unused", { validator })
  assert.equal(result.valid, true)
  assert.equal(received, source)
})

test("validation request extracts Shader.code through the shared binary codec", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-validation-tool-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = "shader_type spatial;\nvoid vertex() { VERTEX += INSTANCE_CUSTOM.xyz; }\n"
  await writeFile(path.join(directory, "test.material"), minimalShaderMaterial(source))

  const result = await validateShaderRequest({ path: "test.material" }, directory)
  assert.equal(result.valid, true)
  assert.equal(result.shader_type, "spatial")
})

test("validation request requires exactly one input mode", async () => {
  for (const request of [{}, { shader_code: "shader_type spatial;", path: "test.material" }]) {
    await assert.rejects(
      () => validateShaderRequest(request, process.cwd()),
      (error: unknown) => error instanceof GodotReaderError && error.code === "INVALID_VALIDATE_ARGUMENTS",
    )
  }
})
