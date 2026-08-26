import { BinaryWriter } from "./binary-writer.ts"
import { GodotReaderError } from "./errors.ts"
import { writeStringReference, writeUnicodeString } from "./strings.ts"
import { OBJECT, VARIANT, type VariantValue } from "./variant.ts"

export interface VariantWriteContext {
  stringIndexes: ReadonlyMap<string, number>
  resourceType: string
  propertyName: string
}

export function writeVariant(writer: BinaryWriter, variant: VariantValue, context: VariantWriteContext): void {
  writer.writeU32(variant.type_id)

  switch (variant.type_id) {
    case VARIANT.NIL:
      requireType(variant, "nil", context)
      requireValue(variant.value === null, variant, context)
      return
    case VARIANT.BOOL:
      requireType(variant, "bool", context)
      requireValue(typeof variant.value === "boolean", variant, context)
      writer.writeU32(variant.value ? 1 : 0)
      return
    case VARIANT.INT:
      requireType(variant, "int", context)
      writer.writeI32(requireNumber(variant, context))
      return
    case VARIANT.INT64:
      requireType(variant, "int64", context)
      requireValue(typeof variant.value === "string", variant, context)
      writer.writeI64(variant.value as string)
      return
    case VARIANT.REAL:
      requireType(variant, "real", context)
      writer.writeF32(requireNumber(variant, context))
      return
    case VARIANT.DOUBLE:
      requireType(variant, "double", context)
      writer.writeF64(requireNumber(variant, context))
      return
    case VARIANT.STRING:
      requireType(variant, "string", context)
      requireValue(typeof variant.value === "string", variant, context)
      writeUnicodeString(writer, variant.value as string)
      return
    case VARIANT.VECTOR2:
      writeRealTuple(writer, variant, "vector2", 2, context)
      return
    case VARIANT.RECT2:
      writeRealTuple(writer, variant, "rect2", 4, context)
      return
    case VARIANT.VECTOR3:
      writeRealTuple(writer, variant, "vector3", 3, context)
      return
    case VARIANT.PLANE:
      writeRealTuple(writer, variant, "plane", 4, context)
      return
    case VARIANT.QUAT:
      writeRealTuple(writer, variant, "quat", 4, context)
      return
    case VARIANT.AABB:
      writeRealTuple(writer, variant, "aabb", 6, context)
      return
    case VARIANT.MATRIX3:
      writeRealTuple(writer, variant, "basis", 9, context)
      return
    case VARIANT.TRANSFORM:
      writeRealTuple(writer, variant, "transform", 12, context)
      return
    case VARIANT.MATRIX32:
      writeRealTuple(writer, variant, "transform2d", 6, context)
      return
    case VARIANT.COLOR:
      writeRealTuple(writer, variant, "color", 4, context)
      return
    case VARIANT.NODE_PATH:
      writeNodePath(writer, variant, context)
      return
    case VARIANT.RID:
      requireType(variant, "rid", context)
      writer.writeU32(requireNumber(variant, context))
      return
    case VARIANT.OBJECT:
      writeObject(writer, variant, context)
      return
    case VARIANT.DICTIONARY:
      writeDictionary(writer, variant, context)
      return
    case VARIANT.ARRAY:
      writeArray(writer, variant, context)
      return
    case VARIANT.RAW_ARRAY:
      writeRawArray(writer, variant, context)
      return
    case VARIANT.INT_ARRAY:
      writeScalarArray(writer, variant, "int_array", context, (value) => writer.writeI32(value))
      return
    case VARIANT.REAL_ARRAY:
      writeScalarArray(writer, variant, "real_array", context, (value) => writer.writeF32(value))
      return
    case VARIANT.STRING_ARRAY:
      writeStringArray(writer, variant, context)
      return
    case VARIANT.VECTOR2_ARRAY:
      writeTupleArray(writer, variant, "vector2_array", 2, context)
      return
    case VARIANT.VECTOR3_ARRAY:
      writeTupleArray(writer, variant, "vector3_array", 3, context)
      return
    case VARIANT.COLOR_ARRAY:
      writeTupleArray(writer, variant, "color_array", 4, context)
      return
    default:
      throw unsupportedVariant(variant, context)
  }
}

function writeRealTuple(
  writer: BinaryWriter,
  variant: VariantValue,
  expectedType: string,
  size: number,
  context: VariantWriteContext,
): void {
  requireType(variant, expectedType, context)
  const values = requireNumberArray(variant, context, size)
  for (const value of values) {
    writer.writeF32(value)
  }
}

function writeNodePath(writer: BinaryWriter, variant: VariantValue, context: VariantWriteContext): void {
  requireType(variant, "node_path", context)
  const value = requireRecord(variant, context)
  const names = requireStringArrayValue(value.names, variant, context)
  const subnames = requireStringArrayValue(value.subnames, variant, context)
  requireValue(typeof value.absolute === "boolean", variant, context)
  if (names.length > 0xffff || subnames.length > 0x7fff) {
    throw invalidVariant(variant, context, "NodePath component count is too large")
  }

  writer.writeU16(names.length)
  writer.writeU16(subnames.length | (value.absolute ? 0x8000 : 0))
  for (const name of names) {
    writeStringReference(writer, name, context.stringIndexes)
  }
  for (const subname of subnames) {
    writeStringReference(writer, subname, context.stringIndexes)
  }
}

function writeObject(writer: BinaryWriter, variant: VariantValue, context: VariantWriteContext): void {
  requireType(variant, "object", context)
  const value = requireRecord(variant, context)
  switch (value.kind) {
    case "empty":
      writer.writeU32(OBJECT.EMPTY)
      return
    case "internal_resource":
      writer.writeU32(OBJECT.INTERNAL_RESOURCE)
      writer.writeU32(requireRecordNumber(value.index, variant, context))
      return
    case "external_resource":
      requireValue(typeof value.type === "string" && typeof value.path === "string", variant, context)
      writer.writeU32(OBJECT.EXTERNAL_RESOURCE)
      writeUnicodeString(writer, value.type as string)
      writeUnicodeString(writer, value.path as string)
      return
    case "external_resource_index":
      writer.writeU32(OBJECT.EXTERNAL_RESOURCE_INDEX)
      writer.writeU32(requireRecordNumber(value.index, variant, context))
      return
    default:
      throw invalidVariant(variant, context, `Unsupported Object reference kind ${String(value.kind)}`)
  }
}

function writeDictionary(writer: BinaryWriter, variant: VariantValue, context: VariantWriteContext): void {
  requireType(variant, "dictionary", context)
  requireValue(Array.isArray(variant.value), variant, context)
  const entries = variant.value as unknown[]
  writer.writeU32(entries.length)
  for (const entryValue of entries) {
    requireValue(isRecord(entryValue), variant, context)
    const entry = entryValue as Record<string, unknown>
    requireValue(isVariant(entry.key) && isVariant(entry.value), variant, context)
    writeVariant(writer, entry.key as VariantValue, context)
    writeVariant(writer, entry.value as VariantValue, context)
  }
}

function writeArray(writer: BinaryWriter, variant: VariantValue, context: VariantWriteContext): void {
  requireType(variant, "array", context)
  requireValue(Array.isArray(variant.value), variant, context)
  const values = variant.value as unknown[]
  writer.writeU32(values.length)
  for (const value of values) {
    requireValue(isVariant(value), variant, context)
    writeVariant(writer, value as VariantValue, context)
  }
}

function writeRawArray(writer: BinaryWriter, variant: VariantValue, context: VariantWriteContext): void {
  requireType(variant, "raw_array", context)
  requireValue(variant.value instanceof Uint8Array, variant, context)
  const bytes = variant.value as Uint8Array
  writer.writeU32(bytes.byteLength)
  writer.writeBytes(bytes)
  const padding = (4 - (bytes.byteLength % 4)) % 4
  writer.reserve(padding)
}

function writeScalarArray(
  writer: BinaryWriter,
  variant: VariantValue,
  expectedType: string,
  context: VariantWriteContext,
  write: (value: number) => void,
): void {
  requireType(variant, expectedType, context)
  const values = requireNumberArray(variant, context)
  writer.writeU32(values.length)
  for (const value of values) {
    write(value)
  }
}

function writeStringArray(writer: BinaryWriter, variant: VariantValue, context: VariantWriteContext): void {
  requireType(variant, "string_array", context)
  const values = requireStringArrayValue(variant.value, variant, context)
  writer.writeU32(values.length)
  for (const value of values) {
    writeUnicodeString(writer, value)
  }
}

function writeTupleArray(
  writer: BinaryWriter,
  variant: VariantValue,
  expectedType: string,
  tupleSize: number,
  context: VariantWriteContext,
): void {
  requireType(variant, expectedType, context)
  requireValue(Array.isArray(variant.value), variant, context)
  const tuples = variant.value as unknown[]
  writer.writeU32(tuples.length)
  for (const tuple of tuples) {
    requireValue(Array.isArray(tuple), variant, context)
    const values = tuple as unknown[]
    requireValue(values.length === tupleSize && values.every((value) => typeof value === "number"), variant, context)
    for (const value of values) {
      writer.writeF32(value as number)
    }
  }
}

function requireNumber(variant: VariantValue, context: VariantWriteContext): number {
  requireValue(typeof variant.value === "number", variant, context)
  return variant.value as number
}

function requireNumberArray(
  variant: VariantValue,
  context: VariantWriteContext,
  size?: number,
): number[] {
  requireValue(Array.isArray(variant.value), variant, context)
  const values = variant.value as unknown[]
  requireValue((size === undefined || values.length === size) && values.every((value) => typeof value === "number"), variant, context)
  return values as number[]
}

function requireStringArrayValue(value: unknown, variant: VariantValue, context: VariantWriteContext): string[] {
  requireValue(Array.isArray(value) && value.every((item) => typeof item === "string"), variant, context)
  return value as string[]
}

function requireRecord(variant: VariantValue, context: VariantWriteContext): Record<string, unknown> {
  requireValue(isRecord(variant.value), variant, context)
  return variant.value as Record<string, unknown>
}

function requireRecordNumber(value: unknown, variant: VariantValue, context: VariantWriteContext): number {
  requireValue(typeof value === "number", variant, context)
  return value as number
}

function requireType(variant: VariantValue, expected: string, context: VariantWriteContext): void {
  if (variant.type !== expected) {
    throw invalidVariant(variant, context, `Variant type id ${variant.type_id} is modeled as ${variant.type}, expected ${expected}`)
  }
}

function requireValue(condition: boolean, variant: VariantValue, context: VariantWriteContext): asserts condition {
  if (!condition) {
    throw invalidVariant(variant, context, `Invalid value for Variant ${variant.type}`)
  }
}

function unsupportedVariant(variant: VariantValue, context: VariantWriteContext): GodotReaderError {
  return new GodotReaderError("UNSUPPORTED_VARIANT_FOR_WRITE", `Cannot serialize Godot 3.6 Variant type ${variant.type_id}`, {
    details: variantDetails(variant, context),
  })
}

function invalidVariant(variant: VariantValue, context: VariantWriteContext, message: string): GodotReaderError {
  return new GodotReaderError("SERIALIZATION_FAILED", message, { details: variantDetails(variant, context) })
}

function variantDetails(variant: VariantValue, context: VariantWriteContext): Record<string, unknown> {
  return {
    variant_type: variant.type_id,
    resource_type: context.resourceType,
    property: context.propertyName,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isVariant(value: unknown): value is VariantValue {
  return isRecord(value) && typeof value.type === "string" && typeof value.type_id === "number" && "value" in value
}
