import assert from "node:assert/strict"
import test from "node:test"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { BinaryReader } from "../../.opencode/tools/godot_shader_reader/binary-reader.ts"
import { getShaderCode, parseResource, rewriteShaderCode, serializeResource } from "../../.opencode/tools/godot_shader_reader/codec.ts"
import { GodotReaderError } from "../../.opencode/tools/godot_shader_reader/errors.ts"
import { readUnicodeString } from "../../.opencode/tools/godot_shader_reader/strings.ts"
import { buildRscc, minimalShaderMaterial } from "./fixture-builder.ts"

const decode = (bytes: Uint8Array): Uint8Array => zstdDecompressSync(bytes)
const encode = (bytes: Uint8Array): Uint8Array => zstdCompressSync(bytes)

function metadataPosition(bytes: Uint8Array, headerOffset: number): number {
  const reader = new BinaryReader(bytes)
  reader.seek(headerOffset + 20)
  readUnicodeString(reader)
  return reader.tell()
}

for (const minor of [0, 1, 2, 3, 4, 5, 6]) {
  for (const compressed of [false, true]) {
    for (const legacyValue of [0n, 123n, 9007199254740991n, 9007199254740993n, (1n << 64n) - 29n, (1n << 64n) - 1n]) {
      test(`Godot 3.${minor} ${compressed ? "RSCC" : "RSRC"} preserves legacy uint64 ${legacyValue}`, () => {
        const originalCode = "shader_type spatial;\n// original\n"
        const logical = minimalShaderMaterial(originalCode, !compressed)
        const headerOffset = compressed ? 0 : 4
        const position = metadataPosition(logical, headerOffset)
        const view = new DataView(logical.buffer, logical.byteOffset, logical.byteLength)
        view.setUint32(headerOffset + 12, minor, true)
        view.setBigUint64(position, legacyValue, true)
        const original = compressed ? buildRscc(logical, 4096) : logical
        const before = parseResource(original, decode)
        const expected = legacyValue <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(legacyValue) : legacyValue.toString()
        assert.equal(before.resource.importMetadataOffset, expected)
        assert.doesNotThrow(() => JSON.stringify(before.resource))
        for (const code of [originalCode, "shader_type spatial;", `${originalCode}${"// Unicode 测试\r\n".repeat(400)}`]) {
          const rewritten = rewriteShaderCode(original, code, decode, encode)
          assert.equal(getShaderCode(rewritten.after.resource), code)
          assert.equal(rewritten.after.resource.importMetadataOffset, expected)
          assert.deepEqual(Uint8Array.from(rewritten.after.resource.bytes.subarray(position, position + 8)), Uint8Array.from(logical.subarray(position, position + 8)))
          assert.equal(rewritten.validation.only_shader_changed, true)
        }
      })
    }
  }
}

test("unsafe real internal-resource offsets are still rejected", () => {
  const bytes = minimalShaderMaterial()
  const reader = new BinaryReader(bytes)
  reader.seek(metadataPosition(bytes, 4) + 8 + 14 * 4)
  const strings = reader.readU32()
  for (let index = 0; index < strings; index++) readUnicodeString(reader)
  assert.equal(reader.readU32(), 0) // external resources
  assert.equal(reader.readU32(), 2) // internal resources
  readUnicodeString(reader)
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(reader.tell(), 1n << 63n, true)
  assert.throws(() => parseResource(bytes), (error: unknown) =>
    error instanceof GodotReaderError && error.code === "INVALID_BINARY_RESOURCE" && /internal resource offset/.test(error.message))
})

test("invalid manually edited legacy uint64 values fail serialization", () => {
  for (const value of ["not-a-number", "-1", "18446744073709551616", 9007199254740992]) {
    const parsed = parseResource(minimalShaderMaterial())
    parsed.resource.importMetadataOffset = value
    assert.throws(() => serializeResource(parsed), (error: unknown) =>
      error instanceof GodotReaderError && error.code === "SERIALIZATION_FAILED")
  }
})
