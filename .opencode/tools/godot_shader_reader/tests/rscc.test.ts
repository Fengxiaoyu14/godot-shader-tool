import assert from "node:assert/strict"
import test from "node:test"
import { zstdDecompressSync } from "node:zlib"

import { GodotReaderError } from "../errors.ts"
import { openGodotContainer } from "../rscc.ts"
import { buildRscc } from "./fixture-builder.ts"

const decode = (bytes: Uint8Array): Uint8Array => zstdDecompressSync(bytes)

for (const size of [7, 8, 9, 16]) {
  test(`RSCC round trip uses Godot's block-count rule for ${size} bytes`, () => {
    const payload = new Uint8Array(size).fill(0x61)
    payload.set(new TextEncoder().encode("RSRC"), size - 4)
    const container = buildRscc(payload, 8)
    const opened = openGodotContainer(container, decode)
    assert.deepEqual(opened.resourceBytes, payload)
    assert.equal(opened.metadata.block_count, Math.floor(size / 8) + 1)
  })
}

test("RSCC rejects a zero block size", () => {
  const payload = new TextEncoder().encode("dataRSRC")
  const container = buildRscc(payload, 8)
  new DataView(container.buffer, container.byteOffset, container.byteLength).setUint32(8, 0, true)
  expectCode(() => openGodotContainer(container, decode), "INVALID_RSCC_HEADER")
})

test("RSCC rejects a damaged physical footer", () => {
  const container = buildRscc(new TextEncoder().encode("dataRSRC"), 8)
  container[container.byteLength - 1] ^= 0xff
  expectCode(() => openGodotContainer(container, decode), "INVALID_RSCC_HEADER")
})

test("RSCC rejects damaged compressed data", () => {
  const container = buildRscc(new TextEncoder().encode("dataRSRC"), 8)
  const blockCount = 2
  const payloadOffset = 16 + blockCount * 4
  container[payloadOffset] ^= 0xff
  expectCode(() => openGodotContainer(container, decode), "DECOMPRESSION_FAILED")
})

test("RSCC validates each decompressed block size", () => {
  const container = buildRscc(new TextEncoder().encode("dataRSRC"), 8)
  expectCode(() => openGodotContainer(container, () => new Uint8Array()), "DECOMPRESSION_SIZE_MISMATCH")
})

function expectCode(operation: () => unknown, code: string): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof GodotReaderError && error.code === code,
  )
}
