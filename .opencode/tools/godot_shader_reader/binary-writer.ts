import { GodotReaderError } from "./errors.ts"

const INITIAL_CAPACITY = 256
const MAX_U32 = 0xffff_ffff
const MAX_U64 = 0xffff_ffff_ffff_ffffn

export class BinaryWriter {
  private bytes = new Uint8Array(INITIAL_CAPACITY)
  private view = new DataView(this.bytes.buffer)
  private position = 0
  private littleEndian = true

  setBigEndian(bigEndian: boolean): void {
    this.littleEndian = !bigEndian
  }

  tell(): number {
    return this.position
  }

  writeU8(value: number): void {
    this.requireInteger(value, 0xff, "u8")
    this.ensure(1)
    this.view.setUint8(this.position, value)
    this.position += 1
  }

  writeU16(value: number): void {
    this.requireInteger(value, 0xffff, "u16")
    this.ensure(2)
    this.view.setUint16(this.position, value, this.littleEndian)
    this.position += 2
  }

  writeU32(value: number): void {
    this.requireInteger(value, MAX_U32, "u32")
    this.ensure(4)
    this.view.setUint32(this.position, value, this.littleEndian)
    this.position += 4
  }

  writeI32(value: number): void {
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw serializationError(`Value ${value} does not fit in i32`)
    }
    this.ensure(4)
    this.view.setInt32(this.position, value, this.littleEndian)
    this.position += 4
  }

  writeU64(value: number | bigint): void {
    const integer = typeof value === "bigint" ? value : numberToBigInt(value, "u64")
    if (integer < 0n || integer > MAX_U64) {
      throw serializationError(`Value ${integer} does not fit in u64`)
    }
    this.ensure(8)
    this.view.setBigUint64(this.position, integer, this.littleEndian)
    this.position += 8
  }

  writeI64(value: number | bigint | string): void {
    let integer: bigint
    try {
      integer = typeof value === "bigint" ? value : BigInt(value)
    } catch (cause) {
      throw serializationError(`Value ${String(value)} is not a valid i64`, cause)
    }
    if (integer < -0x8000_0000_0000_0000n || integer > 0x7fff_ffff_ffff_ffffn) {
      throw serializationError(`Value ${integer} does not fit in i64`)
    }
    this.ensure(8)
    this.view.setBigInt64(this.position, integer, this.littleEndian)
    this.position += 8
  }

  writeF32(value: number): void {
    this.requireNumber(value, "f32")
    this.ensure(4)
    this.view.setFloat32(this.position, value, this.littleEndian)
    this.position += 4
  }

  writeF64(value: number): void {
    this.requireNumber(value, "f64")
    this.ensure(8)
    this.view.setFloat64(this.position, value, this.littleEndian)
    this.position += 8
  }

  writeBytes(value: Uint8Array): void {
    this.ensure(value.byteLength)
    this.bytes.set(value, this.position)
    this.position += value.byteLength
  }

  writeUtf8(value: string): void {
    this.writeBytes(new TextEncoder().encode(value))
  }

  reserve(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw serializationError(`Invalid reservation length ${length}`)
    }
    const offset = this.position
    this.ensure(length)
    this.bytes.fill(0, this.position, this.position + length)
    this.position += length
    return offset
  }

  patchU32(offset: number, value: number): void {
    this.requirePatch(offset, 4)
    this.requireInteger(value, MAX_U32, "u32")
    this.view.setUint32(offset, value, this.littleEndian)
  }

  patchU64(offset: number, value: number | bigint): void {
    this.requirePatch(offset, 8)
    const integer = typeof value === "bigint" ? value : numberToBigInt(value, "u64")
    if (integer < 0n || integer > MAX_U64) {
      throw serializationError(`Value ${integer} does not fit in u64`)
    }
    this.view.setBigUint64(offset, integer, this.littleEndian)
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.position)
  }

  private ensure(additional: number): void {
    const required = this.position + additional
    if (!Number.isSafeInteger(required)) {
      throw serializationError("Serialized resource is too large")
    }
    if (required <= this.bytes.byteLength) {
      return
    }

    let capacity = this.bytes.byteLength
    while (capacity < required) {
      capacity = Math.max(capacity * 2, required)
      if (!Number.isSafeInteger(capacity)) {
        throw serializationError("Serialized resource is too large")
      }
    }
    const grown = new Uint8Array(capacity)
    grown.set(this.bytes)
    this.bytes = grown
    this.view = new DataView(grown.buffer)
  }

  private requireInteger(value: number, maximum: number, label: string): void {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw serializationError(`Value ${value} does not fit in ${label}`)
    }
  }

  private requireNumber(value: number, label: string): void {
    if (typeof value !== "number") {
      throw serializationError(`Value ${String(value)} is not a ${label}`)
    }
  }

  private requirePatch(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > this.position) {
      throw serializationError(`Patch at ${offset} is outside the written buffer`)
    }
  }
}

function numberToBigInt(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw serializationError(`Value ${value} is not a safe ${label} integer`)
  }
  return BigInt(value)
}

function serializationError(message: string, cause?: unknown): GodotReaderError {
  return new GodotReaderError("SERIALIZATION_FAILED", message, cause === undefined ? {} : { cause })
}
