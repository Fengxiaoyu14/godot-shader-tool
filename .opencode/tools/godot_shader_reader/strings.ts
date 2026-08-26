import { BinaryReader } from "./binary-reader.ts"
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
