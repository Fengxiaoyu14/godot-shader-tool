import assert from "node:assert/strict"
import test from "node:test"

import { BinaryReader } from "../binary-reader.ts"
import { GodotReaderError } from "../errors.ts"

test("BinaryReader performs bounds checks with a structured error", () => {
  const reader = new BinaryReader(new Uint8Array([1, 2, 3]), "test buffer")
  assert.throws(
    () => reader.readU32(),
    (error: unknown) => error instanceof GodotReaderError && error.code === "OUT_OF_BOUNDS" && error.offset === 0,
  )
})

test("BinaryReader honors seek bounds", () => {
  const reader = new BinaryReader(new Uint8Array(4))
  assert.throws(
    () => reader.seek(5),
    (error: unknown) => error instanceof GodotReaderError && error.code === "OUT_OF_BOUNDS",
  )
})
