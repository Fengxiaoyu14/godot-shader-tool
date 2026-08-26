import assert from "node:assert/strict"
import test from "node:test"

import { BinaryReader } from "../binary-reader.ts"
import { BinaryWriter } from "../binary-writer.ts"
import { readStringReference, readUnicodeString, writeStringReference, writeUnicodeString } from "../strings.ts"

for (const value of ["", "ASCII", "中文注释", "line 1\nline 2", "line 1\r\nline 2", "𝄞 music"]) {
  test(`UnicodeString round-trips ${JSON.stringify(value)}`, () => {
    const writer = new BinaryWriter()
    writeUnicodeString(writer, value)
    assert.equal(readUnicodeString(new BinaryReader(writer.toUint8Array())), value)
  })
}

test("StringName uses the table when present and inline UTF-8 otherwise", () => {
  const writer = new BinaryWriter()
  const indexes = new Map([["code", 0]])
  writeStringReference(writer, "code", indexes)
  writeStringReference(writer, "中文属性", indexes)
  const reader = new BinaryReader(writer.toUint8Array())
  assert.equal(readStringReference(reader, ["code"]), "code")
  assert.equal(readStringReference(reader, ["code"]), "中文属性")
})
