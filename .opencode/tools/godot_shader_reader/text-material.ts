import { isDeepStrictEqual } from "node:util"
import { decodeShaderUtf8, inspectTextResource, type TextResourceInspection } from "./text-shader.ts"
import { parseTextVariant, encodeTextVariant, type TextVariantContext } from "./text-variant.ts"
import { materialParams, checkedValue } from "./material-params.ts"
import { GodotReaderError } from "./errors.ts"
import type { BinaryResourceModel } from "./resource.ts"
import type { ParamPatchOp } from "./patch.ts"
import type { PreparedShaderWrite } from "./shader-rewrite.ts"

function textModel(text: string, inspection: TextResourceInspection) {
  const major = inspection.formatVersion >= 3 ? 4 : 3
  const internals = inspection.sections.filter(s => s.name !== "ext_resource")
  const externals = inspection.sections.filter(s => s.name === "ext_resource")
  for (const entries of [externals, internals.filter(s => s.name === "sub_resource")]) {
    const ids = entries.map(s => s.attributes.get("id")?.value)
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new GodotReaderError("INVALID_TEXT_RESOURCE", "Resource IDs must be present and unique within each table")
  }
  const externalResources = externals.map(s => ({ type: s.attributes.get("type")?.value ?? "", path: s.attributes.get("path")?.value ?? "" }))
  const context: TextVariantContext = {
    externalResources,
    externalIds: new Map(externals.map((s, i) => [s.attributes.get("id")?.value ?? "", i])),
    internalIds: new Map(internals.map((s, i) => [s.attributes.get("id")?.value ?? "", major === 4 ? i : Number(s.attributes.get("id")?.value ?? 0)])),
  }
  const model: BinaryResourceModel = {
    bytes: new Uint8Array(), resourceHeaderOffset: 0, bigEndian: false, useReal64: false,
    versionMajor: major, versionMinor: 0, formatVersion: 0, type: inspection.type,
    importMetadataOffset: 0, reservedFields: [major === 4 ? 1 : 0, ...Array(13).fill(0)], stringTable: [],
    externalResources, footerOffset: 0,
    internalResources: internals.map((s, i) => ({ path: s.name === "resource" ? "root" : `local://${s.attributes.get("id")?.value ?? i}`, offset: 0 })),
    parsedInternalResources: [],
  }
  model.parsedInternalResources = internals.map((s, i) => {
    const type = s.name === "resource" ? inspection.type : s.attributes.get("type")?.value ?? ""
    return { index: i, path: model.internalResources[i]!.path, offset: 0, type,
      properties: [...s.properties].filter(([name]) => name === "shader" || name === "code" || name.startsWith(major === 4 ? "shader_parameter/" : "shader_param/"))
        .map(([name, p]) => ({ name, offset: p.start, value: parseTextVariant(p.raw, context) })) }
  })
  return { model, internals, major }
}

export function textMaterialParams(text: string, inspection: TextResourceInspection, rootCode?: string) {
  return materialParams(textModel(text, inspection).model, rootCode)
}

/** Change only asserted value spans; all comments and unrelated text stay exact. */
export function prepareTextMaterialWrite(original: Uint8Array, beforeCode: string, code: string, ops: ParamPatchOp[]): PreparedShaderWrite & { paramChanges: unknown[] } {
  const text = decodeShaderUtf8(original, true)
  const inspected = inspectTextResource(text)
  if (inspected.type !== "ShaderMaterial") throw new GodotReaderError("NOT_SHADER_MATERIAL", "setParam requires a ShaderMaterial")
  const { model, internals, major } = textModel(text, inspected)
  const edits = new Map<number, { start: number; end: number; text: string }>()
  const changes: unknown[] = []
  for (const [opIndex, op] of ops.entries()) {
    const matches = model.parsedInternalResources.filter(r => r.type === "ShaderMaterial" && (op.setParam.internal_resource_index === undefined || r.index === op.setParam.internal_resource_index))
      .flatMap(r => r.properties.filter(p => p.name === `${major === 4 ? "shader_parameter" : "shader_param"}/${op.setParam.name}`).map(p => ({ r, p })))
    if (matches.length !== op.expect) throw new GodotReaderError("PATCH_EXPECT_MISMATCH", "Parameter count assertion failed", { details: { op_index: opIndex, expected: op.expect, actual: matches.length } })
    for (const { r, p } of matches) {
      if (op.setParam.type !== undefined && op.setParam.type !== p.value.type) throw new GodotReaderError("INVALID_PATCH", "setParam.type must match the existing Variant type")
      if ("expected_value" in op.setParam && !isDeepStrictEqual(op.setParam.expected_value, p.value.value)) throw new GodotReaderError("PATCH_EXPECT_MISMATCH", "Parameter old-value assertion failed")
      const old = structuredClone(p.value)
      p.value = { ...p.value, value: checkedValue(p.value.type, op.setParam.value, true) }
      const span = internals[r.index]!.properties.get(p.name)!
      edits.set(span.start, { start: span.start, end: span.end, text: encodeTextVariant(p.value, major) })
      changes.push({ internal_resource_index: r.index, name: op.setParam.name, before: old, after: structuredClone(p.value) })
    }
  }
  if (code !== beforeCode) {
    if (inspected.externalPath || inspected.start === undefined || inspected.end === undefined) throw new GodotReaderError("INVALID_PATCH", "Cannot edit an external Shader and material parameters in one transaction")
    edits.set(inspected.start, { start: inspected.start, end: inspected.end, text: JSON.stringify(code) })
  }
  let output = text
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  const bytes = new TextEncoder().encode(output)
  const verify = (actual: Uint8Array) => {
    if (actual.length !== bytes.length || actual.some((byte, i) => byte !== bytes[i])) throw new GodotReaderError("UNEXPECTED_RESOURCE_CHANGE", "Text outside the requested code and parameter values changed")
    const written = inspectTextResource(decodeShaderUtf8(actual, true))
    if (!written.externalPath && written.code !== code) throw new GodotReaderError("SHADER_VERIFY_FAILED", "Read-back Shader.code does not match")
    // Parsing the actual value text also proves the requested Variant types survived.
    const after = textModel(output, written).model
    for (const r of model.parsedInternalResources.filter(r => r.type === "ShaderMaterial")) {
      for (const p of r.properties.filter(p => p.name.startsWith(major === 4 ? "shader_parameter/" : "shader_param/"))) {
        const other = after.parsedInternalResources[r.index]!.properties.find(v => v.name === p.name)
        if (!other || !isDeepStrictEqual(p.value, other.value)) throw new GodotReaderError("UNEXPECTED_RESOURCE_CHANGE", "Parameter value or Variant type changed during text serialization")
      }
    }
    return code
  }
  verify(bytes)
  return { bytes, beforeCode, resourceType: inspected.type, verify, paramChanges: changes }
}
