import { BinaryReader } from "./binary-reader.ts"
import { BinaryWriter } from "./binary-writer.ts"
import { GodotReaderError } from "./errors.ts"

const INLINE_STRING_FLAG = 0x80000000
const INLINE_STRING_LENGTH_MASK = 0x7fffffff

export function readUnicodeString(reader: BinaryReader): string {
  const lengthOffset = reader.absoluteOffset()
  const length = reader.readU32()
  return readNullTerminatedUtf8(reader, length, lengthOffset, "UnicodeString")
}

export function readStringReference(reader: BinaryReader, stringTable: readonly string[]): string {
  const idOffset = reader.absoluteOffset()
  const id = reader.readU32()

  if ((id & INLINE_STRING_FLAG) !== 0) {
    const length = id & INLINE_STRING_LENGTH_MASK
    return readNullTerminatedUtf8(reader, length, idOffset, "inline StringName")
  }

  if (id >= stringTable.length) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", `String table index ${id} is out of range`, {
      offset: idOffset,
      details: { string_table_size: stringTable.length },
    })
  }

  return stringTable[id]
}

export function writeUnicodeString(writer: BinaryWriter, value: string): void {
  const payload = encodeUtf8Exact(value)
  writer.writeU32(payload.byteLength + 1)
  writer.writeBytes(payload)
  writer.writeU8(0)
}

export function writeStringReference(
  writer: BinaryWriter,
  value: string,
  stringIndexes: ReadonlyMap<string, number>,
): void {
  const index = stringIndexes.get(value)
  if (index !== undefined) {
    writer.writeU32(index)
    return
  }

  const payload = encodeUtf8Exact(value)
  const storedLength = payload.byteLength + 1
  if (storedLength > INLINE_STRING_LENGTH_MASK) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "Inline StringName is too large", {
      details: { utf8_length: payload.byteLength },
    })
  }
  writer.writeU32((INLINE_STRING_FLAG | storedLength) >>> 0)
  writer.writeBytes(payload)
  writer.writeU8(0)
}

export function encodeUtf8Exact(value: string): Uint8Array {
  if (value.includes("\0")) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "Godot resource strings cannot contain embedded NUL bytes")
  }
  const encoded = new TextEncoder().encode(value)
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded)
  if (decoded !== value) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "String is not losslessly encodable as UTF-8")
  }
  return encoded
}

function readNullTerminatedUtf8(
  reader: BinaryReader,
  length: number,
  lengthOffset: number,
  fieldName: string,
): string {
  if (length === 0) {
    return ""
  }

  const bytes = reader.readBytes(length)
  if (bytes[bytes.length - 1] !== 0) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", `${fieldName} is missing its terminating NUL byte`, {
      offset: lengthOffset,
      details: { length },
    })
  }

  if (bytes.subarray(0, -1).includes(0)) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", `${fieldName} contains an embedded NUL byte`, {
      offset: lengthOffset,
      details: { length },
    })
  }

  const payload = bytes.subarray(0, -1)
  const payloadReader = new BinaryReader(payload, fieldName, reader.absoluteOffset() - length)
  return payloadReader.readUtf8(payload.length)
}
