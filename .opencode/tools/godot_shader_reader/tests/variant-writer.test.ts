import assert from "node:assert/strict"
import test from "node:test"

import { BinaryReader } from "../binary-reader.ts"
import { BinaryWriter } from "../binary-writer.ts"
import { GodotReaderError } from "../errors.ts"
import { VARIANT, parseVariant, type ExternalResource, type VariantValue } from "../variant.ts"
import { writeVariant } from "../variant-writer.ts"

const externalResources: ExternalResource[] = [{ type: "Texture", path: "res://texture.png" }]
const stringTable = ["root"]
const stringIndexes = new Map(stringTable.map((value, index) => [value, index]))

const variants: VariantValue[] = [
  value("nil", null, VARIANT.NIL),
  value("bool", true, VARIANT.BOOL),
  value("int", -42, VARIANT.INT),
  value("int64", "-9007199254740993", VARIANT.INT64),
  value("real", 1.5, VARIANT.REAL),
  value("double", Math.PI, VARIANT.DOUBLE),
  value("string", "// 中文\r\n", VARIANT.STRING),
  value("vector2", [1.5, -2], VARIANT.VECTOR2),
  value("rect2", [1, 2, 3, 4], VARIANT.RECT2),
  value("vector3", [1, 2, 3], VARIANT.VECTOR3),
  value("plane", [1, 2, 3, 4], VARIANT.PLANE),
  value("quat", [1, 2, 3, 4], VARIANT.QUAT),
  value("aabb", [1, 2, 3, 4, 5, 6], VARIANT.AABB),
  value("basis", [1, 2, 3, 4, 5, 6, 7, 8, 9], VARIANT.MATRIX3),
  value("transform", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], VARIANT.TRANSFORM),
  value("transform2d", [1, 2, 3, 4, 5, 6], VARIANT.MATRIX32),
  value("color", [0, 0.25, 0.5, 1], VARIANT.COLOR),
  value("node_path", { absolute: true, names: ["root", "child"], subnames: ["value"] }, VARIANT.NODE_PATH),
  value("rid", 123, VARIANT.RID),
  value("object", { kind: "empty" }, VARIANT.OBJECT),
  value("object", { kind: "internal_resource", index: 7 }, VARIANT.OBJECT),
  value("object", { kind: "external_resource", type: "Texture", path: "res://legacy.png" }, VARIANT.OBJECT),
  value("object", { kind: "external_resource_index", index: 0, resource: externalResources[0] }, VARIANT.OBJECT),
  value(
    "dictionary",
    [{ key: value("string", "key", VARIANT.STRING), value: value("int", 7, VARIANT.INT) }],
    VARIANT.DICTIONARY,
  ),
  value("array", [value("bool", false, VARIANT.BOOL), value("string", "item", VARIANT.STRING)], VARIANT.ARRAY),
  value("raw_array", new Uint8Array([1, 2, 3]), VARIANT.RAW_ARRAY),
  value("int_array", [-1, 2, 3], VARIANT.INT_ARRAY),
  value("real_array", [1.5, 2.5], VARIANT.REAL_ARRAY),
  value("string_array", ["a", "中"], VARIANT.STRING_ARRAY),
  value("vector2_array", [[1, 2], [3, 4]], VARIANT.VECTOR2_ARRAY),
  value("vector3_array", [[1, 2, 3]], VARIANT.VECTOR3_ARRAY),
  value("color_array", [[0, 0.5, 1, 1]], VARIANT.COLOR_ARRAY),
]

for (const [index, original] of variants.entries()) {
  test(`Variant writer round-trips ${original.type} case ${index}`, () => {
    const writer = new BinaryWriter()
    writeVariant(writer, original, { stringIndexes, resourceType: "TestResource", propertyName: "test" })
    const parsed = parseVariant(new BinaryReader(writer.toUint8Array()), {
      stringTable,
      externalResources,
      resourceType: "TestResource",
      propertyName: "test",
      formatVersion: 3,
    })
    assert.deepEqual(parsed, original)
  })
}

test("Variant writer rejects unsupported types with write context", () => {
  const writer = new BinaryWriter()
  assert.throws(
    () => writeVariant(writer, value("future", null, 999), {
      stringIndexes,
      resourceType: "ShaderMaterial",
      propertyName: "shader_param/future",
    }),
    (error: unknown) =>
      error instanceof GodotReaderError &&
      error.code === "UNSUPPORTED_VARIANT_FOR_WRITE" &&
      error.details?.variant_type === 999 &&
      error.details?.resource_type === "ShaderMaterial" &&
      error.details?.property === "shader_param/future",
  )
})

function value(type: string, variantValue: unknown, typeId: number): VariantValue {
  return { type, value: variantValue, type_id: typeId }
}
