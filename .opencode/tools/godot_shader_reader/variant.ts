import { BinaryReader } from "./binary-reader.ts"
import { GodotReaderError } from "./errors.ts"
import { readStringReference, readUnicodeString } from "./strings.ts"

export const VARIANT = {
  NIL: 1,
  BOOL: 2,
  INT: 3,
  REAL: 4,
  STRING: 5,
  VECTOR2: 10,
  RECT2: 11,
  VECTOR3: 12,
  PLANE: 13,
  QUAT: 14,
  AABB: 15,
  MATRIX3: 16,
  TRANSFORM: 17,
  MATRIX32: 18,
  COLOR: 20,
  NODE_PATH: 22,
  RID: 23,
  OBJECT: 24,
  DICTIONARY: 26,
  ARRAY: 30,
  RAW_ARRAY: 31,
  INT_ARRAY: 32,
  REAL_ARRAY: 33,
  STRING_ARRAY: 34,
  VECTOR3_ARRAY: 35,
  COLOR_ARRAY: 36,
  VECTOR2_ARRAY: 37,
  INT64: 40,
  DOUBLE: 41,
} as const

export const OBJECT = {
  EMPTY: 0,
  EXTERNAL_RESOURCE: 1,
  INTERNAL_RESOURCE: 2,
  EXTERNAL_RESOURCE_INDEX: 3,
} as const

const MAX_COLLECTION_LENGTH = 1_000_000
const MAX_RECURSION_DEPTH = 64

export interface ExternalResource {
  type: string
  path: string
}

export interface VariantValue {
  type: string
  value: unknown
  type_id: number
}

export interface VariantContext {
  stringTable: readonly string[]
  externalResources: readonly ExternalResource[]
  resourceType: string
  propertyName: string
  formatVersion: number
  depth?: number
}

export function parseVariant(reader: BinaryReader, context: VariantContext): VariantValue {
  const typeOffset = reader.absoluteOffset()
  const type = reader.readU32()
  const depth = context.depth ?? 0
  if (depth > MAX_RECURSION_DEPTH) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", "Variant nesting is too deep", {
      offset: typeOffset,
      details: variantDetails(context, type),
    })
  }

  switch (type) {
    case VARIANT.NIL:
      return variant("nil", null, type)
    case VARIANT.BOOL:
      return variant("bool", reader.readU32() !== 0, type)
    case VARIANT.INT:
      return variant("int", reader.readI32(), type)
    case VARIANT.INT64:
      return variant("int64", reader.readI64().toString(), type)
    case VARIANT.REAL:
      return variant("real", reader.readF32(), type)
    case VARIANT.DOUBLE:
      return variant("double", reader.readF64(), type)
    case VARIANT.STRING:
      return variant("string", readUnicodeString(reader), type)
    case VARIANT.VECTOR2:
      return variant("vector2", readReals(reader, 2), type)
    case VARIANT.RECT2:
      return variant("rect2", readReals(reader, 4), type)
    case VARIANT.VECTOR3:
      return variant("vector3", readReals(reader, 3), type)
    case VARIANT.PLANE:
      return variant("plane", readReals(reader, 4), type)
    case VARIANT.QUAT:
      return variant("quat", readReals(reader, 4), type)
    case VARIANT.AABB:
      return variant("aabb", readReals(reader, 6), type)
    case VARIANT.MATRIX3:
      return variant("basis", readReals(reader, 9), type)
    case VARIANT.TRANSFORM:
      return variant("transform", readReals(reader, 12), type)
    case VARIANT.MATRIX32:
      return variant("transform2d", readReals(reader, 6), type)
    case VARIANT.COLOR:
      return variant("color", readReals(reader, 4), type)
    case VARIANT.NODE_PATH:
      return parseNodePath(reader, context, type)
    case VARIANT.RID:
      return variant("rid", reader.readU32(), type)
    case VARIANT.OBJECT:
      return parseObject(reader, context, type, typeOffset)
    case VARIANT.DICTIONARY:
      return parseDictionary(reader, context, type)
    case VARIANT.ARRAY:
      return parseArray(reader, context, type)
    case VARIANT.RAW_ARRAY:
      return parseRawArray(reader, type)
    case VARIANT.INT_ARRAY:
      return parseFixedArray(reader, type, "int_array", () => reader.readI32())
    case VARIANT.REAL_ARRAY:
      return parseFixedArray(reader, type, "real_array", () => reader.readF32())
    case VARIANT.STRING_ARRAY:
      return parseFixedArray(reader, type, "string_array", () => readUnicodeString(reader))
    case VARIANT.VECTOR2_ARRAY:
      return parseFixedArray(reader, type, "vector2_array", () => readReals(reader, 2))
    case VARIANT.VECTOR3_ARRAY:
      return parseFixedArray(reader, type, "vector3_array", () => readReals(reader, 3))
    case VARIANT.COLOR_ARRAY:
      return parseFixedArray(reader, type, "color_array", () => readReals(reader, 4))
    default:
      throw new GodotReaderError("UNSUPPORTED_VARIANT_TYPE", `Unsupported Godot 3.6 Variant type ${type}`, {
        offset: typeOffset,
        details: variantDetails(context, type),
      })
  }
}

function parseObject(
  reader: BinaryReader,
  context: VariantContext,
  variantType: number,
  typeOffset: number,
): VariantValue {
  const objectType = reader.readU32()
  switch (objectType) {
    case OBJECT.EMPTY:
      return variant("object", { kind: "empty" }, variantType)
    case OBJECT.INTERNAL_RESOURCE:
      return variant("object", { kind: "internal_resource", index: reader.readU32() }, variantType)
    case OBJECT.EXTERNAL_RESOURCE: {
      const resourceType = readUnicodeString(reader)
      const path = readUnicodeString(reader)
      return variant("object", { kind: "external_resource", type: resourceType, path }, variantType)
    }
    case OBJECT.EXTERNAL_RESOURCE_INDEX: {
      const index = reader.readU32()
      const resource = context.externalResources[index]
      if (resource === undefined) {
        throw new GodotReaderError("INVALID_BINARY_RESOURCE", `External resource index ${index} is out of range`, {
          offset: typeOffset,
          details: { ...variantDetails(context, variantType), external_resource_count: context.externalResources.length },
        })
      }
      return variant("object", { kind: "external_resource_index", index, resource }, variantType)
    }
    default:
      throw new GodotReaderError("INVALID_BINARY_RESOURCE", `Unknown Godot object reference type ${objectType}`, {
        offset: typeOffset,
        details: { ...variantDetails(context, variantType), object_type: objectType },
      })
  }
}

function parseNodePath(reader: BinaryReader, context: VariantContext, type: number): VariantValue {
  const nameCount = reader.readU16()
  const encodedSubnameCount = reader.readU16()
  const absolute = (encodedSubnameCount & 0x8000) !== 0
  let subnameCount = encodedSubnameCount & 0x7fff
  if (context.formatVersion < 3) {
    subnameCount += 1
  }
  validateCount(nameCount, reader, "NodePath name")
  validateCount(subnameCount, reader, "NodePath subname")

  const names: string[] = []
  const subnames: string[] = []
  for (let index = 0; index < nameCount; index++) {
    names.push(readStringReference(reader, context.stringTable))
  }
  for (let index = 0; index < subnameCount; index++) {
    subnames.push(readStringReference(reader, context.stringTable))
  }
  return variant("node_path", { absolute, names, subnames }, type)
}

function parseDictionary(reader: BinaryReader, context: VariantContext, type: number): VariantValue {
  const length = reader.readU32() & 0x7fffffff
  validateCount(length, reader, "Dictionary")
  const entries: Array<{ key: VariantValue; value: VariantValue }> = []
  for (let index = 0; index < length; index++) {
    entries.push({
      key: parseVariant(reader, nested(context)),
      value: parseVariant(reader, nested(context)),
    })
  }
  return variant("dictionary", entries, type)
}

function parseArray(reader: BinaryReader, context: VariantContext, type: number): VariantValue {
  const length = reader.readU32() & 0x7fffffff
  validateCount(length, reader, "Array")
  const values: VariantValue[] = []
  for (let index = 0; index < length; index++) {
    values.push(parseVariant(reader, nested(context)))
  }
  return variant("array", values, type)
}

function parseRawArray(reader: BinaryReader, type: number): VariantValue {
  const length = reader.readU32()
  validateCount(length, reader, "RawArray")
  const bytes = reader.readBytes(length)
  advancePadding(reader, length)
  return variant("raw_array", bytes, type)
}

function parseFixedArray<T>(
  reader: BinaryReader,
  type: number,
  name: string,
  readElement: () => T,
): VariantValue {
  const length = reader.readU32()
  validateCount(length, reader, name)
  const values: T[] = []
  for (let index = 0; index < length; index++) {
    values.push(readElement())
  }
  return variant(name, values, type)
}

function readReals(reader: BinaryReader, count: number): number[] {
  const values: number[] = []
  for (let index = 0; index < count; index++) {
    values.push(reader.readF32())
  }
  return values
}

function advancePadding(reader: BinaryReader, length: number): void {
  const extra = 4 - (length % 4)
  if (extra < 4) {
    reader.skip(extra)
  }
}

function validateCount(length: number, reader: BinaryReader, name: string): void {
  if (length > MAX_COLLECTION_LENGTH) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", `${name} length exceeds the safety limit`, {
      offset: reader.absoluteOffset() - 4,
      details: { length, limit: MAX_COLLECTION_LENGTH },
    })
  }
}

function nested(context: VariantContext): VariantContext {
  return { ...context, depth: (context.depth ?? 0) + 1 }
}

function variant(type: string, value: unknown, typeId: number): VariantValue {
  return { type, value, type_id: typeId }
}

function variantDetails(context: VariantContext, type: number): Record<string, unknown> {
  return {
    variant_type_id: type,
    resource: context.resourceType,
    property: context.propertyName,
  }
}
