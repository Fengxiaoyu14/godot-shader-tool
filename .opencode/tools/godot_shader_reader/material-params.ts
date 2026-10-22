import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { parseResource, serializeResource, setShaderCode, validateContainerPreserved, type ParsedResource } from "./codec.ts"
import type { BinaryResourceModel } from "./resource.ts"
import { GodotReaderError } from "./errors.ts"
import type { ShaderFileWriteOptions } from "./file-writer.ts"
import type { PreparedShaderWrite } from "./shader-rewrite.ts"
import type { ParamPatchOp } from "./patch.ts"

export const resourceHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Lexical declarations only; default expressions are reported, never evaluated. */
export function uniformIndex(code: string) {
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, s => s.replace(/[^\r\n]/g, " "))
  return [...masked.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*([^;]*);/g)].map(m => ({
    name: m[2], type: m[1], line: code.slice(0, m.index!).split("\n").length,
    declaration: code.slice(m.index!, m.index! + m[0].length),
    default_expression: m[3].includes("=") ? m[3].slice(m[3].indexOf("=") + 1).trim() : null,
  }))
}

export function materialParams(model: BinaryResourceModel, rootCode?: string) {
  const materials = model.parsedInternalResources.filter(r => r.type === "ShaderMaterial").map(r => {
    const reference = r.properties.find(p => p.name === "shader")?.value.value as any
    const shader = reference?.kind === "internal_resource"
      ? (model.versionMajor === 4 && (model.reservedFields[0]! & 1) ? model.parsedInternalResources[reference.index] : model.parsedInternalResources.find(s => s.path === `local://${reference.index}` && s.type === "Shader")) : undefined
    const code = shader?.properties.find(p => p.name === "code")?.value.value
    const resolvedCode = typeof code === "string" ? code : r.index === model.parsedInternalResources.length - 1 ? rootCode : undefined
    const properties = r.properties.filter(p => p.name.startsWith(model.versionMajor === 4 ? "shader_parameter/" : "shader_param/")).map(p => {
      const v = p.value.value as any
      const ext = p.value.type === "object" && v?.kind === "external_resource_index" ? model.externalResources[v.index] : undefined
      const inline = p.value.type === "object" && v?.kind === "external_resource" ? v : undefined
      return { name: p.name.slice(model.versionMajor === 4 ? 17 : 13), property: p.name, ...p.value,
        ...(ext ? { external_resource: { id: v.index, ...ext } } : inline ? { external_resource: { id: null, type: inline.type, path: inline.path } } : {}) }
    })
    const assigned = new Set(properties.filter(p => p.type !== "nil" && !(p.type === "object" && (p.value as any)?.kind === "empty")).map(p => p.name))
    const uniforms = resolvedCode === undefined ? [] : uniformIndex(resolvedCode).map(u => ({ ...u, assigned: assigned.has(u.name), source: assigned.has(u.name) ? "material" : "shader_default" }))
    return { internal_resource_index: r.index, path: r.path, properties, uniforms,
      uniform_index_available: resolvedCode !== undefined, unassigned_uniforms: uniforms.filter(u => !u.assigned).map(u => u.name) }
  })
  const external_resources = model.externalResources.map((e, id) => ({ id, ...e, bindings: materials.flatMap(m => m.properties.filter(p => p.external_resource?.id === id).map(p => ({ internal_resource_index: m.internal_resource_index, uniform: p.name }))) }))
  return { materials, external_resources }
}

export function prepareMaterialWrite(original: Uint8Array, beforeCode: string, code: string, ops: ParamPatchOp[], options: ShaderFileWriteOptions): PreparedShaderWrite & { paramChanges: unknown[] } {
  const before = parseResource(original, options.zstdDecoder)
  if (before.resource.type !== "ShaderMaterial") throw new GodotReaderError("NOT_SHADER_MATERIAL", "setParam requires a binary ShaderMaterial")
  const working = parseResource(original, options.zstdDecoder)
  if (code !== beforeCode) setShaderCode(working.resource, code)
  const changes: unknown[] = []
  for (const [opIndex, op] of ops.entries()) {
    const matches = working.resource.parsedInternalResources.filter(r => r.type === "ShaderMaterial" && (op.setParam.internal_resource_index === undefined || r.index === op.setParam.internal_resource_index))
      .flatMap(r => r.properties.filter(p => p.name === `${working.resource.versionMajor === 4 ? "shader_parameter" : "shader_param"}/${op.setParam.name}`).map(p => ({ r, p })))
    if (matches.length !== op.expect) throw new GodotReaderError("PATCH_EXPECT_MISMATCH", "Parameter count assertion failed", { details: { op_index: opIndex, expected: op.expect, actual: matches.length } })
    for (const { r, p } of matches) {
      if (op.setParam.type !== undefined && op.setParam.type !== p.value.type) throw new GodotReaderError("INVALID_PATCH", "setParam.type must match the existing Variant type")
      if ("expected_value" in op.setParam && !isDeepStrictEqual(op.setParam.expected_value, p.value.value)) throw new GodotReaderError("PATCH_EXPECT_MISMATCH", "Parameter old-value assertion failed")
      const old = structuredClone(p.value)
      const value = checkedValue(p.value.type, op.setParam.value)
      p.value = { ...p.value, value }
      changes.push({ internal_resource_index: r.index, name: op.setParam.name, before: old, after: structuredClone(p.value) })
    }
  }
  const bytes = serializeResource(working, options.zstdEncoder)
  const expected = semanticResource(working)
  const verify = (bytes: Uint8Array) => {
    const after = parseResource(bytes, options.zstdDecoder)
    validateContainerPreserved(before.container, after.container)
    if (!isDeepStrictEqual(expected, semanticResource(after))) throw new GodotReaderError("UNEXPECTED_RESOURCE_CHANGE", "Read-back differs from the requested code and parameter changes")
    return code
  }
  verify(bytes)
  return { bytes, beforeCode, resourceType: before.resource.type, verify, paramChanges: changes }
}

function checkedValue(type: string, value: unknown): unknown {
  const fail = () => { throw new GodotReaderError("INVALID_PATCH", `Invalid or unsupported setParam value for ${type}`) }
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
  const f32 = (v: number) => { const n = Math.fround(v); if (!Number.isFinite(n)) fail(); return n }
  if (type === "real" || type === "double") { if (!finite(value)) return fail(); return type === "real" ? f32(value) : value }
  if (type === "int") { if (!finite(value) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) return fail(); return value }
  if (type === "bool") { if (typeof value !== "boolean") return fail(); return value }
  if (type === "string") { if (typeof value !== "string") return fail(); return value }
  const sizes: Record<string, number> = { color: 4, vector2: 2, vector3: 3, rect2: 4, plane: 4, quat: 4, aabb: 6, basis: 9, transform: 12, transform2d: 6 }
  if (sizes[type]) { if (!Array.isArray(value) || value.length !== sizes[type] || !value.every(finite)) return fail(); return value.map(f32) }
  return fail()
}

/** Layout offsets may move; all semantic fields, property order and types must match. */
function semanticResource(parsed: ParsedResource) {
  const { bytes, resourceHeaderOffset, internalResources, parsedInternalResources, footerOffset, ...header } = parsed.resource
  return { ...header, internalResources: internalResources.map(({ path }) => path),
    parsedInternalResources: parsedInternalResources.map(({ offset, properties, ...r }) => ({ ...r, properties: properties.map(({ offset, ...p }) => p) })) }
}
