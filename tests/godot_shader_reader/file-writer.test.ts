import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdDecompressSync } from "node:zlib"

import { readGodot36Shader } from "../../.opencode/tools/godot_shader_reader/index.ts"
import { replaceFileSafely, writeGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-writer.ts"
import { GodotReaderError } from "../../.opencode/tools/godot_shader_reader/errors.ts"
import type { ShaderValidator } from "../../.opencode/tools/godot_shader_reader/validator.ts"
import { buildRscc, minimalShaderMaterial } from "./fixture-builder.ts"

const alwaysValid: ShaderValidator = async () => ({
  valid: true,
  godot_version: "3.6",
  renderer: "gles3",
  shader_type: "spatial",
})

test("file writer validates a sibling temp before replacing the original", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materialPath = path.join(directory, "test.material")
  await writeFile(materialPath, minimalShaderMaterial("shader_type spatial;\n"))

  const requested = "shader_type spatial;\r\n// 中文\r\n"
  const result = await writeGodotShaderFile(materialPath, requested)
  assert.deepEqual(result.validation, {
    pre_write_shader: true,
    resource_read_back: true,
    shader_code_match: true,
    semantic_diff: true,
    post_write_shader: true,
  })
  assert.equal(readGodot36Shader(await readFile(materialPath)).shader.code, requested)
  assert.deepEqual(await readdir(directory), ["test.material"])
})

test("official pre-write validation rejects invalid Shader code and preserves the original", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-failure-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materialPath = path.join(directory, "test.material")
  const original = minimalShaderMaterial("shader_type spatial;\n")
  await writeFile(materialPath, original)

  await assert.rejects(
    () => writeGodotShaderFile(materialPath, ""),
    (error: unknown) => error instanceof GodotReaderError &&
      error.code === "SHADER_VALIDATION_FAILED" &&
      error.details?.phase === "pre_write",
  )
  assert.deepEqual(await readFile(materialPath), original)
  assert.deepEqual(await readdir(directory), ["test.material"])
})

test("compression failure leaves an RSCC original unchanged", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-compress-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materialPath = path.join(directory, "test.material")
  const original = buildRscc(minimalShaderMaterial("shader_type spatial;\n", false), 4096)
  await writeFile(materialPath, original)

  await assert.rejects(
    () => writeGodotShaderFile(materialPath, "shader_type spatial;\n// changed\n", {
      zstdDecoder: (bytes) => zstdDecompressSync(bytes),
      zstdEncoder: () => {
        throw new Error("injected compression failure")
      },
      shaderValidator: alwaysValid,
    }),
    (error: unknown) => error instanceof GodotReaderError && error.code === "COMPRESSION_FAILED",
  )
  assert.deepEqual(await readFile(materialPath), original)
  assert.deepEqual(await readdir(directory), ["test.material"])
})

test("unavailable validator fails closed before serialization", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-unavailable-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materialPath = path.join(directory, "test.material")
  const original = minimalShaderMaterial("shader_type spatial;\n")
  await writeFile(materialPath, original)

  const unavailable: ShaderValidator = async () => {
    throw new GodotReaderError("SHADER_VALIDATOR_UNAVAILABLE", "injected unavailable validator")
  }
  await assert.rejects(
    () => writeGodotShaderFile(materialPath, "shader_type spatial;\n", { shaderValidator: unavailable }),
    (error: unknown) => error instanceof GodotReaderError &&
      error.code === "SHADER_VALIDATOR_UNAVAILABLE" &&
      error.details?.phase === "pre_write",
  )
  assert.deepEqual(await readFile(materialPath), original)
  assert.deepEqual(await readdir(directory), ["test.material"])
})

test("failed validation of actual temp-file read-back preserves the original", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-post-validation-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materialPath = path.join(directory, "test.material")
  const original = minimalShaderMaterial("shader_type spatial;\n")
  const requested = "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(0.4); }\n"
  await writeFile(materialPath, original)
  const validatedSources: string[] = []

  const failAfterReadBack: ShaderValidator = async (source) => {
    validatedSources.push(source)
    if (validatedSources.length === 1) {
      return {
        valid: true,
        godot_version: "3.6",
        renderer: "gles3",
        shader_type: "spatial",
      }
    }
    return {
      valid: false,
      godot_version: "3.6",
      renderer: "gles3",
      shader_type: "spatial",
      error: { line: 2, message: "injected post-write rejection" },
    }
  }

  await assert.rejects(
    () => writeGodotShaderFile(materialPath, requested, { shaderValidator: failAfterReadBack }),
    (error: unknown) => error instanceof GodotReaderError &&
      error.code === "SHADER_VALIDATION_FAILED" &&
      error.line === 2 &&
      error.details?.phase === "post_write",
  )
  assert.deepEqual(validatedSources, [requested, requested])
  assert.deepEqual(await readFile(materialPath), original)
  assert.deepEqual(await readdir(directory), ["test.material"])
})

test("Windows two-stage replacement removes the backup after success", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-windows-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const targetPath = path.join(directory, "test.material")
  const tempPath = path.join(directory, "test.material.tmp")
  const backupPath = path.join(directory, "test.material.backup")
  await writeFile(targetPath, "old")
  await writeFile(tempPath, "new")

  await replaceFileSafely(tempPath, targetPath, { platform: "win32", backupPath })
  assert.equal(await readFile(targetPath, "utf8"), "new")
  assert.deepEqual(await readdir(directory), ["test.material"])
})

test("Windows second-stage failure restores the original material", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-windows-failure-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const targetPath = path.join(directory, "test.material")
  const tempPath = path.join(directory, "test.material.tmp")
  const backupPath = path.join(directory, "test.material.backup")
  await writeFile(targetPath, "old")
  await writeFile(tempPath, "new")
  let renameCount = 0

  await assert.rejects(
    () => replaceFileSafely(tempPath, targetPath, {
      platform: "win32",
      backupPath,
      renameFile: async (from, to) => {
        renameCount++
        if (renameCount === 2) {
          throw new Error("injected destination rename failure")
        }
        await import("node:fs/promises").then((fs) => fs.rename(from, to))
      },
    }),
    (error: unknown) => error instanceof GodotReaderError && error.code === "ATOMIC_REPLACE_FAILED",
  )
  assert.equal(renameCount, 3)
  assert.equal(await readFile(targetPath, "utf8"), "old")
  assert.equal(await readFile(tempPath, "utf8"), "new")
  assert.deepEqual((await readdir(directory)).sort(), ["test.material", "test.material.tmp"])
})
