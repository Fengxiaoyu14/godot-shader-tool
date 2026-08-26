import { BinaryWriter } from "./binary-writer.ts"
import { GodotReaderError } from "./errors.ts"
import type { ContainerMetadata } from "./rscc.ts"

const MAGIC_RSCC = "RSCC"
const MAGIC_RSRC = "RSRC"
const COMPRESSION_ZSTD = 2

export type ZstdEncoder = (uncompressed: Uint8Array) => Uint8Array

interface BunZstdApi {
  zstdCompressSync(data: Uint8Array): Uint8Array
}

export const defaultZstdEncoder: ZstdEncoder = (uncompressed) => {
  const bun = (globalThis as typeof globalThis & { Bun?: BunZstdApi }).Bun
  if (!bun?.zstdCompressSync) {
    throw new GodotReaderError(
      "ZSTD_RUNTIME_UNAVAILABLE",
      "Bun.zstdCompressSync is required to write Godot 3.6 RSCC/ZSTD resources",
    )
  }
  return bun.zstdCompressSync(uncompressed)
}

export function encodeGodotContainer(
  resourceBytes: Uint8Array,
  metadata: ContainerMetadata,
  zstdEncoder = defaultZstdEncoder,
): Uint8Array {
  if (metadata.format === "RSRC") {
    requireMagic(resourceBytes, 0, MAGIC_RSRC, "Uncompressed resource header")
    requireMagic(resourceBytes, resourceBytes.byteLength - 4, MAGIC_RSRC, "Binary resource footer")
    return resourceBytes
  }

  const compressionMode = metadata.compression_mode
  const blockSize = metadata.block_size
  if (compressionMode !== COMPRESSION_ZSTD) {
    throw new GodotReaderError(
      "UNSUPPORTED_COMPRESSION",
      `Cannot write Godot compression mode ${String(compressionMode)}`,
      { details: { supported_mode: COMPRESSION_ZSTD } },
    )
  }
  if (!Number.isInteger(blockSize) || (blockSize as number) <= 0) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "RSCC block size must be greater than zero")
  }
  if (resourceBytes.byteLength > 0xffff_ffff) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "RSCC logical stream exceeds the Godot 3.6 u32 size limit")
  }
  requireMagic(resourceBytes, resourceBytes.byteLength - 4, MAGIC_RSRC, "Binary resource footer")

  const actualBlockSize = blockSize as number
  const blockCount = Math.floor(resourceBytes.byteLength / actualBlockSize) + 1
  const compressedBlocks: Uint8Array[] = []
  for (let index = 0; index < blockCount; index++) {
    const start = index * actualBlockSize
    const length = index === blockCount - 1 ? resourceBytes.byteLength % actualBlockSize : actualBlockSize
    const block = resourceBytes.subarray(start, start + length)
    try {
      const compressed = zstdEncoder(block)
      if (!(compressed instanceof Uint8Array) || compressed.byteLength > 0xffff_ffff) {
        throw new Error("ZSTD encoder returned an invalid block")
      }
      compressedBlocks.push(compressed)
    } catch (cause) {
      if (cause instanceof GodotReaderError) {
        throw cause
      }
      throw new GodotReaderError("COMPRESSION_FAILED", `ZSTD compression failed for RSCC block ${index}`, {
        details: { block_index: index, uncompressed_size: length },
        cause,
      })
    }
  }

  const writer = new BinaryWriter()
  writer.writeUtf8(MAGIC_RSCC)
  writer.writeU32(compressionMode)
  writer.writeU32(actualBlockSize)
  writer.writeU32(resourceBytes.byteLength)
  for (const block of compressedBlocks) {
    writer.writeU32(block.byteLength)
  }
  for (const block of compressedBlocks) {
    writer.writeBytes(block)
  }
  writer.writeUtf8(MAGIC_RSCC)
  return writer.toUint8Array()
}

function requireMagic(bytes: Uint8Array, offset: number, expected: string, label: string): void {
  const actual = offset < 0 ? "" : String.fromCharCode(...bytes.subarray(offset, offset + expected.length))
  if (actual !== expected) {
    throw new GodotReaderError("SERIALIZATION_FAILED", `${label} is missing or invalid`, {
      offset: Math.max(0, offset),
    })
  }
}
