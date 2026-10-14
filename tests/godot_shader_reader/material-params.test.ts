import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { parseResource, serializeResource } from "../../.opencode/tools/godot_shader_reader/codec.ts"
import { readGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-reader.ts"
import { patchGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-writer.ts"
import { diffGodotMaterials } from "../../.opencode/tools/godot_shader_reader/material-diff.ts"
import { resourceHash, prepareMaterialWrite } from "../../.opencode/tools/godot_shader_reader/material-params.ts"
import { minimalShaderMaterial, externalShaderMaterial, buildRscc } from "./fixture-builder.ts"

const source = `shader_type spatial;
// uniform float Fake;
uniform float TexSize = 1.0;
uniform float DoubleValue;
uniform vec4 Col : hint_color = vec4(1.0);
uniform sampler2D Tex;
uniform float Missing = 2.0;
void fragment() { ALBEDO = Col.rgb; }
`
function fixture(external = false, textureIndex = 0) {
  const parsed = parseResource(external ? externalShaderMaterial("shared.gdshader") : minimalShaderMaterial(source))
  const model = parsed.resource
  if (!external) model.externalResources = textureIndex ? [{ type: "Texture", path: "res://unused.png" }, { type: "Texture", path: "res://soil.png" }] : [{ type: "Texture", path: "res://soil.png" }]
  else model.externalResources.push({ type: "Texture", path: "res://soil.png" })
  const root = model.parsedInternalResources.at(-1)!
  const values = [
    { name: "TexSize", type: "real", type_id: 4, value: 0.1 },
    { name: "DoubleValue", type: "double", type_id: 41, value: 0.1234567890123 },
    { name: "Col", type: "color", type_id: 20, value: [0.5, 0.4, 0.3, 1] },
    { name: "Tex", type: "object", type_id: 24, value: { kind: "external_resource_index", index: external ? 1 : textureIndex, resource: model.externalResources[external ? 1 : textureIndex] } },
  ]
  for (const { name, ...value } of values) root.properties.push({ name: `shader_param/${name}`, value, offset: 0 })
  return serializeResource(parsed)
}
async function setup(t: any, bytes = fixture()) {
  const dir = await mkdtemp(path.join(tmpdir(), "material-params-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "test.material")
  await writeFile(file, bytes)
  return { dir, file }
}
const set = (name: string, value: unknown, extra = {}) => ({ setParam: { name, value, ...extra }, expect: 1 })

test("read returns values, Variant types, binding paths and unassigned defaults; params:false opts out", async t => {
  const { file } = await setup(t)
  const read = await readGodotShaderFile(file)
  assert.equal(read.resource_hash, resourceHash(await readFile(file)))
  const m = read.params!.materials[0]
  assert.equal(m.properties.find(p => p.name === "TexSize")!.value, Math.fround(0.1))
  assert.equal(m.properties.find(p => p.name === "Col")!.type, "color")
  assert.deepEqual(m.unassigned_uniforms, ["Missing"])
  assert.equal(m.uniforms.find(u => u.name === "Missing")!.default_expression, "2.0")
  assert.deepEqual(read.params!.external_resources[0].bindings, [{ internal_resource_index: 1, uniform: "Tex" }])
  assert.equal((await readGodotShaderFile(file, { params: false })).params, undefined)
})

test("real/double/Color updates preserve types, code and unrelated resources with official pre/post validation", async t => {
  const { file } = await setup(t)
  const original = await readGodotShaderFile(file)
  const result = await patchGodotShaderFile(file, [set("TexSize", 1, { type: "real" }), set("Col", [0.1, 0.2, 0.3, 1]), set("DoubleValue", 0.9876543210123)], { expectedHash: original.shader.hash, expectedResourceHash: original.resource_hash })
  assert.equal(result.param_changes!.length, 3)
  const read = await readGodotShaderFile(file)
  assert.equal(read.shader.code, source)
  assert.deepEqual(read.params!.materials[0].properties.find(p => p.name === "Col")!.value, [0.1, 0.2, 0.3, 1].map(Math.fround))
  const double = read.params!.materials[0].properties.find(p => p.name === "DoubleValue")!
  assert.equal(double.type_id, 41)
  assert.equal(double.value, 0.9876543210123)
  assert.deepEqual(read.params!.external_resources, original.params!.external_resources)
})

test("bad count, type, old value, invalid value or stale material hash leaves file and directory unchanged", async t => {
  const { file, dir } = await setup(t)
  const original = await readFile(file)
  for (const ops of [[set("TexSize", 1), set("Absent", 2)], [set("Col", [1, 2, 3])], [set("TexSize", 2, { type: "double" })], [set("TexSize", 2, { expected_value: 99 })], [set("TexSize", Infinity)], [{ ...set("TexSize", 1), expect: 2 }]]) {
    await assert.rejects(patchGodotShaderFile(file, ops))
    assert.deepEqual(await readFile(file), original)
  }
  await assert.rejects(patchGodotShaderFile(file, [set("TexSize", 1)], { expectedResourceHash: "0".repeat(64) }), { code: "RESOURCE_HASH_MISMATCH" })
  assert.deepEqual(await readdir(dir), ["test.material"])
})

test("dry run and mixed embedded code/parameter patch remain transactional", async t => {
  const { file } = await setup(t)
  const before = await readFile(file)
  const ops = [set("TexSize", 2), { find: "Col.rgb", replace: "vec3(0.5)", expect: 1 }]
  await patchGodotShaderFile(file, ops, { dryRun: true })
  assert.deepEqual(await readFile(file), before)
  await patchGodotShaderFile(file, ops)
  assert.match((await readGodotShaderFile(file)).shader.code, /vec3\(0.5\)/)
})

test("parameter-only external material patch preserves shared Shader bytes; mixed two-file patch rejects", async t => {
  const { file, dir } = await setup(t, fixture(true))
  const shared = path.join(dir, "shared.gdshader")
  await writeFile(shared, source)
  await patchGodotShaderFile(file, [set("TexSize", 2)])
  assert.equal(await readFile(shared, "utf8"), source)
  assert.equal((await readGodotShaderFile(file)).params!.materials[0].uniforms.length, 5)
  const before = await readFile(file)
  await assert.rejects(patchGodotShaderFile(file, [set("TexSize", 3), { find: "Col.rgb", replace: "vec3(1.0)", expect: 1 }]), { code: "INVALID_PATCH" })
  assert.deepEqual(await readFile(file), before)
})

test("diff compares texture paths rather than unstable table ids and shows param and code changes", async t => {
  const { file, dir } = await setup(t)
  const other = path.join(dir, "other.material")
  await writeFile(other, fixture(false, 1))
  assert.equal((await diffGodotMaterials(file, other)).equal, true)
  await patchGodotShaderFile(other, [set("TexSize", 1), { find: "Col.rgb", replace: "vec3(1.0)", expect: 1 }])
  const diff = await diffGodotMaterials(file, other)
  assert.equal(diff.equal, false)
  assert.equal(diff.parameter_diff.length, 1)
  assert.equal(diff.parameter_diff[0].parameter, "root/TexSize")
  assert.equal(diff.shader.changed, true)
})

test("RSCC container and read-back whitelist retain unrelated values; corrupted temp fails", async t => {
  const parsed = parseResource(fixture())
  const { serializeBinaryResource } = await import("../../.opencode/tools/godot_shader_reader/resource-writer.ts")
  const bytes = buildRscc(serializeBinaryResource(parsed.resource, { includeMagicHeader: false }), 256)
  const { file } = await setup(t, bytes)
  const zstd = { zstdDecoder: zstdDecompressSync, zstdEncoder: zstdCompressSync }
  await patchGodotShaderFile(file, [set("TexSize", 1)], zstd)
  assert.equal((await readGodotShaderFile(file, zstd)).container.format, "RSCC")
  const prepared = prepareMaterialWrite(fixture(), source, source, [set("TexSize", 1)], {})
  const tampered = parseResource(prepared.bytes)
  tampered.resource.externalResources[0].path = "res://wrong.png"
  await assert.rejects(async () => prepared.verify(serializeResource(tampered)), { code: "UNEXPECTED_RESOURCE_CHANGE" })
})

test("multiple internal materials require explicit count or target index", async t => {
  const p = parseResource(fixture())
  const clone = structuredClone(p.resource.parsedInternalResources.at(-1)!)
  clone.index = 1; clone.path = "local://2"
  p.resource.parsedInternalResources.splice(1, 0, clone)
  p.resource.parsedInternalResources[2].index = 2
  p.resource.internalResources.splice(1, 0, { path: clone.path, offset: 0 })
  const { file } = await setup(t, serializeResource(p))
  const before = await readFile(file)
  await assert.rejects(patchGodotShaderFile(file, [set("TexSize", 2)]), { code: "PATCH_EXPECT_MISMATCH" })
  assert.deepEqual(await readFile(file), before)
  await patchGodotShaderFile(file, [set("TexSize", 2, { internal_resource_index: 1 })])
  const mats = (await readGodotShaderFile(file)).params!.materials
  assert.equal(mats[0].properties.find(p => p.name === "TexSize")!.value, 2)
  assert.equal(mats[1].properties.find(p => p.name === "TexSize")!.value, Math.fround(0.1))
  await patchGodotShaderFile(file, [{ ...set("TexSize", 3), expect: 2 }])
  assert.ok((await readGodotShaderFile(file)).params!.materials.every(m => m.properties.find(p => p.name === "TexSize")!.value === 3))
})

test("post validator failure cleans temp and preserves material", async t => {
  const { file, dir } = await setup(t)
  const before = await readFile(file)
  let calls = 0
  const shaderValidator = async () => {
    if (++calls === 2) throw new Error("post validator failed")
    return { valid: true as const, godot_version: "3.6" as const, renderer: "gles3" as const, shader_type: "spatial" as const }
  }
  await assert.rejects(patchGodotShaderFile(file, [set("TexSize", 2)], { shaderValidator }), { code: "SHADER_VALIDATOR_FAILED" })
  assert.deepEqual(await readFile(file), before)
  assert.deepEqual(await readdir(dir), ["test.material"])
})
