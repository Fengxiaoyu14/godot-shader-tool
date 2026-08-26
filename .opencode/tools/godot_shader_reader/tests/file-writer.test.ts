import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdDecompressSync } from "node:zlib"

import { readGodot36Shader } from "../index.ts"
import { replaceFileSafely, writeGodotShaderFile } from "../file-writer.ts"
import { GodotReaderError } from "../errors.ts"
import { buildRscc, minimalShaderMaterial } from "./fixture-builder.ts"

test("file writer validates a sibling temp before replacing the original", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materialPath = path.join(directory, "test.material")
  await writeFile(materialPath, minimalShaderMaterial("shader_type spatial;\n"))

  const requested = "shader_type spatial;\r\n// 中文\r\n"
  const result = await writeGodotShaderFile(materialPath, requested)
  assert.deepEqual(result.validation, { read_back: true, shader_code_match: true, only_shader_changed: true })
  assert.equal(readGodot36Shader(await readFile(materialPath)).shader.code, requested)
  assert.deepEqual(await readdir(directory), ["test.material"])
})

test("failure before replacement leaves the original bytes unchanged", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-shader-writer-failure-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const materialPath = path.join(directory, "test.material")
  const original = minimalShaderMaterial("shader_type spatial;\n")
  await writeFile(materialPath, original)

  await assert.rejects(
    () => writeGodotShaderFile(materialPath, ""),
    (error: unknown) => error instanceof GodotReaderError && error.code === "INVALID_SHADER_CODE",
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
    }),
    (error: unknown) => error instanceof GodotReaderError && error.code === "COMPRESSION_FAILED",
  )
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
