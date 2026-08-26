import { BinaryReader } from "./binary-reader.ts"
import { GodotReaderError } from "./errors.ts"

const MAGIC_RSCC = "RSCC"
const MAGIC_RSRC = "RSRC"
const MAGIC_SIZE = 4
const RSCC_COMPRESSION_MODE_OFFSET = 4
const RSCC_BLOCK_SIZE_OFFSET = 8
const RSCC_UNCOMPRESSED_SIZE_OFFSET = 12
const RSCC_FIXED_HEADER_SIZE = 16
const COMPRESSION_ZSTD = 2
const MAX_UNCOMPRESSED_SIZE = 512 * 1024 * 1024

export type ZstdDecoder = (compressed: Uint8Array) => Uint8Array

export interface ContainerMetadata {
  format: "RSCC" | "RSRC"
  compression?: "zstd"
  compression_mode?: number
  block_size?: number
  block_count?: number
  compressed_size?: number
  compressed_payload_size?: number
  uncompressed_size: number
}

export interface OpenedContainer {
  resourceBytes: Uint8Array
  resourceHeaderOffset: number
  metadata: ContainerMetadata
}

interface BunZstdApi {
  zstdDecompressSync(data: Uint8Array): Uint8Array
}

export const defaultZstdDecoder: ZstdDecoder = (compressed) => {
  const bun = (globalThis as typeof globalThis & { Bun?: BunZstdApi }).Bun
  if (!bun?.zstdDecompressSync) {
    throw new GodotReaderError(
      "ZSTD_RUNTIME_UNAVAILABLE",
      "Bun.zstdDecompressSync is required to read Godot 3.6 RSCC/ZSTD resources",
    )
  }
  return bun.zstdDecompressSync(compressed)
}

export function openGodotContainer(bytes: Uint8Array, zstdDecoder = defaultZstdDecoder): OpenedContainer {
  if (bytes.byteLength < MAGIC_SIZE) {
    throw new GodotReaderError("INVALID_MAGIC", "File is too short to contain a Godot resource magic")
  }

  const magic = asciiAt(bytes, 0, MAGIC_SIZE)
  if (magic === MAGIC_RSCC) {
    return openRscc(bytes, zstdDecoder)
  }
  if (magic === MAGIC_RSRC) {
    requireMagic(
      bytes,
      bytes.byteLength - MAGIC_SIZE,
      MAGIC_RSRC,
      "INVALID_BINARY_RESOURCE",
      "RSRC footer",
    )
    return {
      resourceBytes: bytes,
      resourceHeaderOffset: 4,
      metadata: {
        format: "RSRC",
        uncompressed_size: bytes.byteLength,
      },
    }
  }

  throw new GodotReaderError("INVALID_MAGIC", `Expected RSCC or RSRC, found ${JSON.stringify(magic)}`, {
    offset: 0,
  })
}

function openRscc(bytes: Uint8Array, zstdDecoder: ZstdDecoder): OpenedContainer {
  const reader = new BinaryReader(bytes, "RSCC container")
  reader.skip(MAGIC_SIZE)

  const compressionMode = reader.readU32()
  const blockSize = reader.readU32()
  const uncompressedSize = reader.readU32()

  if (compressionMode !== COMPRESSION_ZSTD) {
    throw new GodotReaderError("UNSUPPORTED_COMPRESSION", `Godot compression mode ${compressionMode} is not supported`, {
      offset: RSCC_COMPRESSION_MODE_OFFSET,
      details: { supported_mode: COMPRESSION_ZSTD },
    })
  }
  if (blockSize === 0) {
    throw new GodotReaderError("INVALID_RSCC_HEADER", "RSCC block size must be greater than zero", {
      offset: RSCC_BLOCK_SIZE_OFFSET,
    })
  }
  if (uncompressedSize > MAX_UNCOMPRESSED_SIZE) {
    throw new GodotReaderError("INVALID_RSCC_HEADER", "RSCC uncompressed size exceeds the safety limit", {
      offset: RSCC_UNCOMPRESSED_SIZE_OFFSET,
      details: { uncompressed_size: uncompressedSize, limit: MAX_UNCOMPRESSED_SIZE },
    })
  }

  // This intentionally matches Godot 3.6 FileAccessCompressed exactly,
  // including the extra empty final block when size % block_size == 0.
  const blockCount = Math.floor(uncompressedSize / blockSize) + 1
  const tableBytes = blockCount * 4
  if (!Number.isSafeInteger(tableBytes) || tableBytes > reader.remaining() - MAGIC_SIZE) {
    throw new GodotReaderError("INVALID_RSCC_HEADER", "RSCC block table does not fit in the file", {
      offset: reader.absoluteOffset(),
      details: { block_count: blockCount },
    })
  }

  const compressedSizes: number[] = []
  for (let index = 0; index < blockCount; index++) {
    compressedSizes.push(reader.readU32())
  }

  const compressedPayloadSize = compressedSizes.reduce((sum, size) => sum + size, 0)
  const expectedPhysicalSize = RSCC_FIXED_HEADER_SIZE + tableBytes + compressedPayloadSize + MAGIC_SIZE
  if (!Number.isSafeInteger(expectedPhysicalSize) || expectedPhysicalSize !== bytes.byteLength) {
    throw new GodotReaderError("INVALID_RSCC_HEADER", "RSCC block sizes do not match the physical file size", {
      offset: RSCC_FIXED_HEADER_SIZE,
      details: { expected_size: expectedPhysicalSize, actual_size: bytes.byteLength },
    })
  }

  const decompressedBlocks: Uint8Array[] = []
  for (let index = 0; index < blockCount; index++) {
    const compressedSize = compressedSizes[index]!
    const compressedOffset = reader.absoluteOffset()
    const compressed = reader.readBytes(compressedSize)
    const expectedBlockSize = index === blockCount - 1 ? uncompressedSize % blockSize : blockSize

    let decompressed: Uint8Array
    try {
      decompressed = zstdDecoder(compressed)
    } catch (cause) {
      if (cause instanceof GodotReaderError) {
        throw cause
      }
      throw new GodotReaderError("DECOMPRESSION_FAILED", `ZSTD decompression failed for RSCC block ${index}`, {
        offset: compressedOffset,
        details: { block_index: index, compressed_size: compressedSize },
        cause,
      })
    }

    if (decompressed.byteLength !== expectedBlockSize) {
      throw new GodotReaderError(
        "DECOMPRESSION_SIZE_MISMATCH",
        `RSCC block ${index} decompressed to ${decompressed.byteLength} bytes; expected ${expectedBlockSize}`,
        {
          offset: compressedOffset,
          details: { block_index: index, expected_size: expectedBlockSize, actual_size: decompressed.byteLength },
        },
      )
    }
    decompressedBlocks.push(decompressed)
  }

  requireMagic(bytes, reader.absoluteOffset(), MAGIC_RSCC, "INVALID_RSCC_HEADER", "RSCC footer")
  const resourceBytes = concatenate(decompressedBlocks, uncompressedSize)
  requireMagic(
    resourceBytes,
    resourceBytes.byteLength - MAGIC_SIZE,
    MAGIC_RSRC,
    "INVALID_BINARY_RESOURCE",
    "decompressed RSRC footer",
  )

  return {
    resourceBytes,
    resourceHeaderOffset: 0,
    metadata: {
      format: "RSCC",
      compression: "zstd",
      compression_mode: compressionMode,
      block_size: blockSize,
      block_count: blockCount,
      compressed_size: bytes.byteLength,
      compressed_payload_size: compressedPayloadSize,
      uncompressed_size: uncompressedSize,
    },
  }
}

function concatenate(parts: readonly Uint8Array[], totalSize: number): Uint8Array {
  const result = new Uint8Array(totalSize)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  if (offset !== totalSize) {
    throw new GodotReaderError("DECOMPRESSION_SIZE_MISMATCH", "Combined RSCC block size is incorrect", {
      details: { expected_size: totalSize, actual_size: offset },
    })
  }
  return result
}

function requireMagic(
  bytes: Uint8Array,
  offset: number,
  expected: string,
  code: "INVALID_RSCC_HEADER" | "INVALID_BINARY_RESOURCE",
  label: string,
): void {
  if (offset < 0 || offset + expected.length > bytes.byteLength || asciiAt(bytes, offset, expected.length) !== expected) {
    throw new GodotReaderError(code, `Missing or invalid ${label}`, { offset: Math.max(0, offset) })
  }
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) {
    return ""
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}
