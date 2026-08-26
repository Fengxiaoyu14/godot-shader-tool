import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"

import { readGodot36Shader } from "../index.ts"
import { writeGodotShaderFile } from "../file-writer.ts"

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

  const cases = [
    originalCode,
    originalCode.slice(0, Math.max(1, Math.floor(originalCode.length / 2))),
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
    assert.equal(result.validation.read_back, true)
    assert.equal(result.validation.shader_code_match, true)
    assert.equal(result.validation.only_shader_changed, true)
    assert.equal(readGodot36Shader(await readFile(targetPath), bunAvailable ? undefined : decode).shader.code, requested)
  }
})
