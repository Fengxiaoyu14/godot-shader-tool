import assert from "node:assert/strict"
import test from "node:test"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"

import {
  getShaderCode,
  parseResource,
  rewriteShaderCode,
  serializeResource,
  validateShaderOnlyChange,
} from "../../.opencode/tools/godot_shader_reader/codec.ts"
import { GodotReaderError } from "../../.opencode/tools/godot_shader_reader/errors.ts"
import { openGodotContainer } from "../../.opencode/tools/godot_shader_reader/rscc.ts"
import { buildRscc, minimalShaderMaterial } from "./fixture-builder.ts"

const encode = (bytes: Uint8Array): Uint8Array => zstdCompressSync(bytes)
const decode = (bytes: Uint8Array): Uint8Array => zstdDecompressSync(bytes)

test("uncompressed resource performs a no-op semantic round-trip", () => {
  const original = minimalShaderMaterial("shader_type spatial;\n")
  const before = parseResource(original)
  const serialized = serializeResource(before)
  const after = parseResource(serialized)
  assert.equal(getShaderCode(after.resource), getShaderCode(before.resource))
  assert.deepEqual(validateShaderOnlyChange(before.resource, after.resource, getShaderCode(before.resource)), {
    read_back: true,
    shader_code_match: true,
    only_shader_changed: true,
  })
})

test("shorter and longer Shader.code values recalculate following internal offsets", () => {
  const originalCode = `shader_type spatial;\n${"// original\n".repeat(80)}`
  const original = minimalShaderMaterial(originalCode)
  const before = parseResource(original)
  const originalMainOffset = before.resource.internalResources[1]!.offset

  const shorter = rewriteShaderCode(original, "shader_type spatial;\n")
  assert.equal(getShaderCode(shorter.after.resource), "shader_type spatial;\n")
  assert.ok(shorter.after.resource.internalResources[1]!.offset < originalMainOffset)

  const longerCode = `${originalCode}${"// much longer\n".repeat(300)}`
  const longer = rewriteShaderCode(original, longerCode)
  assert.equal(getShaderCode(longer.after.resource), longerCode)
  assert.ok(longer.after.resource.internalResources[1]!.offset > originalMainOffset)
})

for (const code of [
  "shader_type spatial;\n// 控制远处的渐变\n",
  "shader_type spatial;\r\n// CRLF 原样保留\r\n",
  "shader_type spatial;",
  "shader_type spatial;\n",
]) {
  test(`Shader.code is preserved exactly for ${JSON.stringify(code)}`, () => {
    const rewritten = rewriteShaderCode(minimalShaderMaterial(), code)
    assert.equal(getShaderCode(rewritten.after.resource), code)
  })
}

test("RSCC writer preserves ZSTD mode and block size across a block-boundary change", () => {
  const blockSize = 4096
  const logical = minimalShaderMaterial("shader_type spatial;\n", false)
  const original = buildRscc(logical, blockSize)
  const before = parseResource(original, decode)
  assert.equal(before.container.block_count, 1)

  const code = `shader_type spatial;\n${"// grow across the RSCC boundary\n".repeat(400)}`
  const rewritten = rewriteShaderCode(original, code, decode, encode)
  assert.equal(rewritten.after.container.format, "RSCC")
  assert.equal(rewritten.after.container.compression_mode, 2)
  assert.equal(rewritten.after.container.block_size, blockSize)
  assert.ok((rewritten.after.container.block_count ?? 0) >= 3)
  assert.equal(getShaderCode(rewritten.after.resource), code)
})

for (const size of [7, 8, 9, 16, 19]) {
  test(`RSCC encoder follows Godot block count at logical size ${size}`, async () => {
    const { encodeGodotContainer } = await import(
      "../../.opencode/tools/godot_shader_reader/rscc-writer.ts"
    )
    const logical = new Uint8Array(size).fill(0x61)
    logical.set(new TextEncoder().encode("RSRC"), size - 4)
    const physical = encodeGodotContainer(logical, {
      format: "RSCC",
      compression: "zstd",
      compression_mode: 2,
      block_size: 8,
      uncompressed_size: size,
    }, encode)
    const opened = openGodotContainer(physical, decode)
    assert.deepEqual(opened.resourceBytes, logical)
    assert.equal(opened.metadata.block_count, Math.floor(size / 8) + 1)
  })
}

test("semantic validation rejects changes outside Shader.code", () => {
  const before = parseResource(minimalShaderMaterial())
  const after = parseResource(minimalShaderMaterial())
  after.resource.reservedFields[0] = 1
  assert.throws(
    () => validateShaderOnlyChange(before.resource, after.resource, getShaderCode(before.resource)),
    (error: unknown) => error instanceof GodotReaderError && error.code === "UNEXPECTED_RESOURCE_CHANGE",
  )
})

test("empty Shader.code is rejected", () => {
  assert.throws(
    () => rewriteShaderCode(minimalShaderMaterial(), ""),
    (error: unknown) => error instanceof GodotReaderError && error.code === "INVALID_SHADER_CODE",
  )
})
