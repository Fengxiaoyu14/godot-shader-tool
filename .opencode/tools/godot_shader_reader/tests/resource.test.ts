import assert from "node:assert/strict"
import test from "node:test"

import { GodotReaderError } from "../errors.ts"
import { readGodot36Shader } from "../index.ts"
import {
  buildBinaryResource,
  minimalShaderMaterial,
  variantInternalResource,
  variantNil,
  variantString,
  variantUnknown,
} from "./fixture-builder.ts"

test("uncompressed RSRC ShaderMaterial is parsed structurally", () => {
  const result = readGodot36Shader(minimalShaderMaterial())
  assert.equal(result.container.format, "RSRC")
  assert.equal(result.resource.type, "ShaderMaterial")
  assert.equal(result.shader.code, "shader_type spatial;\n")
})

test("non-ShaderMaterial root is rejected", () => {
  const bytes = buildBinaryResource("SpatialMaterial", [
    { path: "res://test.material", type: "SpatialMaterial", properties: [] },
  ])
  expectCode(() => readGodot36Shader(bytes), "NOT_SHADER_MATERIAL")
})

test("missing internal Shader is reported", () => {
  const bytes = buildBinaryResource("ShaderMaterial", [
    {
      path: "res://test.material",
      type: "ShaderMaterial",
      properties: [{ name: "shader", value: variantInternalResource(99) }],
    },
  ])
  expectCode(() => readGodot36Shader(bytes), "SHADER_NOT_FOUND")
})

test("Shader without code is reported", () => {
  const bytes = buildBinaryResource("ShaderMaterial", [
    {
      path: "local://1",
      type: "Shader",
      properties: [{ name: "custom_defines", value: variantString("") }],
    },
    {
      path: "res://test.material",
      type: "ShaderMaterial",
      properties: [{ name: "shader", value: variantInternalResource(1) }],
    },
  ])
  expectCode(() => readGodot36Shader(bytes), "SHADER_CODE_NOT_FOUND")
})

test("Shader.code with a non-String Variant is reported", () => {
  const bytes = buildBinaryResource("ShaderMaterial", [
    {
      path: "local://1",
      type: "Shader",
      properties: [{ name: "code", value: variantNil() }],
    },
    {
      path: "res://test.material",
      type: "ShaderMaterial",
      properties: [{ name: "shader", value: variantInternalResource(1) }],
    },
  ])
  expectCode(() => readGodot36Shader(bytes), "SHADER_CODE_NOT_STRING")
})

test("unknown Variant fails fast with resource/property/offset context", () => {
  const bytes = buildBinaryResource("ShaderMaterial", [
    {
      path: "res://test.material",
      type: "ShaderMaterial",
      properties: [{ name: "shader", value: variantUnknown(999) }],
    },
  ])
  assert.throws(
    () => readGodot36Shader(bytes),
    (error: unknown) =>
      error instanceof GodotReaderError &&
      error.code === "UNSUPPORTED_VARIANT_TYPE" &&
      error.details?.variant_type_id === 999 &&
      error.details?.resource === "ShaderMaterial" &&
      error.details?.property === "shader" &&
      typeof error.offset === "number",
  )
})

test("truncated resource does not crash", () => {
  const bytes = minimalShaderMaterial()
  const truncated = bytes.subarray(0, bytes.byteLength - 2)
  expectCode(() => readGodot36Shader(truncated), "INVALID_BINARY_RESOURCE")
})

test("non-Godot input is rejected by magic", () => {
  expectCode(() => readGodot36Shader(new TextEncoder().encode("not a resource")), "INVALID_MAGIC")
})

function expectCode(operation: () => unknown, code: string): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof GodotReaderError && error.code === code,
  )
}
