import assert from "node:assert/strict"
import test from "node:test"

import { BinaryReader } from "../../.opencode/tools/godot_shader_reader/binary-reader.ts"
import { BinaryWriter } from "../../.opencode/tools/godot_shader_reader/binary-writer.ts"

test("BinaryWriter grows, reserves, and patches Godot primitives", () => {
  const writer = new BinaryWriter()
  writer.writeU8(0x12)
  writer.writeU16(0x3456)
  const u32Offset = writer.reserve(4)
  const u64Offset = writer.reserve(8)
  writer.writeI32(-123)
  writer.writeI64("-9007199254740993")
  writer.writeF32(1.5)
  writer.writeF64(Math.PI)
  writer.writeBytes(new Uint8Array(400).fill(0xaa))
  writer.patchU32(u32Offset, 0x789a_bcde)
  writer.patchU64(u64Offset, 0x1234_5678_9abc_def0n)

  const reader = new BinaryReader(writer.toUint8Array())
  assert.equal(reader.readU8(), 0x12)
  assert.equal(reader.readU16(), 0x3456)
  assert.equal(reader.readU32(), 0x789a_bcde)
  assert.equal(reader.readU64(), 0x1234_5678_9abc_def0n)
  assert.equal(reader.readI32(), -123)
  assert.equal(reader.readI64(), -9007199254740993n)
  assert.equal(reader.readF32(), 1.5)
  assert.equal(reader.readF64(), Math.PI)
  assert.deepEqual(reader.readBytes(400), new Uint8Array(400).fill(0xaa))
  assert.equal(reader.remaining(), 0)
})
