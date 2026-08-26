import { GodotReaderError } from "./errors.ts"

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export class BinaryReader {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly label: string
  private readonly baseOffset: number
  private position = 0
  private littleEndian = true

  constructor(bytes: Uint8Array, label = "binary data", baseOffset = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.label = label
    this.baseOffset = baseOffset
  }

  setBigEndian(bigEndian: boolean): void {
    this.littleEndian = !bigEndian
  }

  tell(): number {
    return this.position
  }

  absoluteOffset(): number {
    return this.baseOffset + this.position
  }

  remaining(): number {
    return this.bytes.byteLength - this.position
  }

  length(): number {
    return this.bytes.byteLength
  }

  seek(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.bytes.byteLength) {
      throw new GodotReaderError("OUT_OF_BOUNDS", `Cannot seek to byte ${offset} in ${this.label}`, {
        offset: this.baseOffset + Math.max(0, offset),
        details: { length: this.bytes.byteLength },
      })
    }
    this.position = offset
  }

  skip(length: number): void {
    this.ensure(length)
    this.position += length
  }

  readU8(): number {
    this.ensure(1)
    return this.view.getUint8(this.position++)
  }

  readU16(): number {
    this.ensure(2)
    const value = this.view.getUint16(this.position, this.littleEndian)
    this.position += 2
    return value
  }

  readU32(): number {
    this.ensure(4)
    const value = this.view.getUint32(this.position, this.littleEndian)
    this.position += 4
    return value
  }

  readI32(): number {
    this.ensure(4)
    const value = this.view.getInt32(this.position, this.littleEndian)
    this.position += 4
    return value
  }

  readU64(): bigint {
    this.ensure(8)
    const value = this.view.getBigUint64(this.position, this.littleEndian)
    this.position += 8
    return value
  }

  readI64(): bigint {
    this.ensure(8)
    const value = this.view.getBigInt64(this.position, this.littleEndian)
    this.position += 8
    return value
  }

  readU64Number(fieldName: string): number {
    const offset = this.absoluteOffset()
    const value = this.readU64()
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GodotReaderError("INVALID_BINARY_RESOURCE", `${fieldName} exceeds JavaScript's safe integer range`, {
        offset,
        details: { value: value.toString() },
      })
    }
    return Number(value)
  }

  readF32(): number {
    this.ensure(4)
    const value = this.view.getFloat32(this.position, this.littleEndian)
    this.position += 4
    return value
  }

  readF64(): number {
    this.ensure(8)
    const value = this.view.getFloat64(this.position, this.littleEndian)
    this.position += 8
    return value
  }

  readBytes(length: number): Uint8Array {
    this.ensure(length)
    const value = this.bytes.subarray(this.position, this.position + length)
    this.position += length
    return value
  }

  readUtf8(length: number): string {
    const offset = this.absoluteOffset()
    const bytes = this.readBytes(length)
    try {
      return UTF8_DECODER.decode(bytes)
    } catch (cause) {
      throw new GodotReaderError("INVALID_BINARY_RESOURCE", `Invalid UTF-8 in ${this.label}`, {
        offset,
        cause,
      })
    }
  }

  readAscii(length: number): string {
    const bytes = this.readBytes(length)
    return String.fromCharCode(...bytes)
  }

  private ensure(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining()) {
      throw new GodotReaderError("OUT_OF_BOUNDS", `Read exceeds ${this.label}`, {
        offset: this.absoluteOffset(),
        details: { requested: length, remaining: this.remaining() },
      })
    }
  }
}
