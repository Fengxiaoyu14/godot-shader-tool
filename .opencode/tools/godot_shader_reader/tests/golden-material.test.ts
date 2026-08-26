import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"

import { readGodot36Shader } from "../index.ts"
import { writeGodotShaderFile } from "../file-writer.ts"
import { GodotReaderError } from "../errors.ts"
import { validateGodot36Shader } from "../validator.ts"

const goldenPath = process.env.GODOT_SHADER_GOLDEN
const decode = (bytes: Uint8Array): Uint8Array => zstdDecompressSync(bytes)
const encode = (bytes: Uint8Array): Uint8Array => zstdCompressSync(bytes)
const bunAvailable = "Bun" in globalThis

test("private Golden Material supports no-op, shorter, longer, Unicode, and multi-block writes", {
  skip: goldenPath === undefined ? "Set GODOT_SHADER_GOLDEN to a private Godot 3.6 ShaderMaterial" : false,
}, async (t) => {
  const sourcePath = goldenPath!
  const originalBytes = await readFile(sourcePath)
  const original = readGodot36Shader(originalBytes, bunAvailable ? undefined : decode)
  const originalCode = original.shader.code
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-golden-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const targetPath = path.join(directory, path.basename(sourcePath))

  const originalValidation = await validateGodot36Shader(originalCode)
  assert.equal(originalValidation.valid, true, "the Golden Shader must compile as Godot 3.6 GLES3")

  const cases = [
    originalCode,
    "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(0.25); }\n",
    `${originalCode}\n${"// longer Golden Shader\n".repeat(200)}`,
    `${originalCode}\n// 控制远处的渐变\r\n// UTF-8 与 CRLF\r\n${"// cross 4096 block\n".repeat(400)}`,
  ]

  for (const requested of cases) {
    await writeFile(targetPath, originalBytes)
    const result = await writeGodotShaderFile(
      targetPath,
      requested,
      bunAvailable ? {} : { zstdDecoder: decode, zstdEncoder: encode },
    )
    assert.equal(result.validation.pre_write_shader, true)
    assert.equal(result.validation.resource_read_back, true)
    assert.equal(result.validation.shader_code_match, true)
    assert.equal(result.validation.semantic_diff, true)
    assert.equal(result.validation.post_write_shader, true)
    assert.equal(readGodot36Shader(await readFile(targetPath), bunAvailable ? undefined : decode).shader.code, requested)
  }

  for (const invalid of [
    "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(1.0) }\n",
    "shader_type spatial;\nvoid fragment() { ALBEDO = missing_value; }\n",
  ]) {
    await writeFile(targetPath, originalBytes)
    await assert.rejects(
      () => writeGodotShaderFile(
        targetPath,
        invalid,
        bunAvailable ? {} : { zstdDecoder: decode, zstdEncoder: encode },
      ),
      (error: unknown) => error instanceof GodotReaderError && error.code === "SHADER_VALIDATION_FAILED",
    )
    assert.deepEqual(await readFile(targetPath), originalBytes)
  }
})
