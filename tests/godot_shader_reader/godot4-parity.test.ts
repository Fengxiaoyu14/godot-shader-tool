import assert from "node:assert/strict"
import test from "node:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { readGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-reader.ts"
import { patchGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-writer.ts"
import { diffGodotMaterials } from "../../.opencode/tools/godot_shader_reader/material-diff.ts"
import { applyShaderPlan } from "../../.opencode/tools/godot_shader_reader/batch.ts"
import { searchGodotShaders } from "../../.opencode/tools/godot_shader_reader/search.ts"
import { parseResource, serializeResource } from "../../.opencode/tools/godot_shader_reader/codec.ts"
import { inspectTextResource } from "../../.opencode/tools/godot_shader_reader/text-shader.ts"
import { sourceView } from "../../.opencode/tools/godot_shader_reader/source-info.ts"
import { minimalShaderMaterial } from "./fixture-builder.ts"
import { prepareMaterialWrite } from "../../.opencode/tools/godot_shader_reader/material-params.ts"

const fixtures = fileURLToPath(new URL("./fixtures/godot4/", import.meta.url))
const engine = process.env.GODOT4_BIN
const options = { zstdDecoder: zstdDecompressSync, zstdEncoder: zstdCompressSync }
const set = (name: string, value: unknown, extra = {}, expect = 1) => ({ setParam: { name, value, ...extra }, expect })
const patch = { find: "tint.rgb", replace: "vec3(0.5)", expect: 1 }

async function setup(t: any) {
  const root = await mkdtemp(path.join(tmpdir(), "godot4-parity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(fixtures, root, { recursive: true })
  return root
}

function reload(root: string, name: string, expectedColor?: number[], checks: string[] = []) {
  if (expectedColor) checks = [...checks, 'r.get_shader_parameter("tint") == Color(' + expectedColor.join(",") + ')']
  const script = 'extends SceneTree\nfunc _initialize():\n var r = load("res://' + name + '")\n if r == null:\n  quit(2)\n  return\n' +
    (checks.length ? ' if not (' + checks.join(" and ") + '):\n  quit(3)\n  return\n' : '') +
    ' print("PARITY_RELOAD_OK")\n quit()\n'
  return writeFile(path.join(root, "reload.gd"), script).then(() => {
    const result = spawnSync(engine!, ["--headless", "--path", root, "--script", "reload.gd"], { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, APPDATA: root, XDG_DATA_HOME: root, GODOT_SILENCE_ROOT_WARNING: "1" } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PARITY_RELOAD_OK/)
    assert.doesNotMatch(result.stderr, /(?:ERROR|Error):/)
  })
}

for (const name of ["embedded.res", "compressed.res", "embedded.tres", "standalone.res", "standalone.tres", "external.res", "external.tres", "external.gdshader"]) {
  test(`4.x parity: asserted literal/line patches, diff, dry-run and stale guards: ${name}`, { skip: !engine }, async t => {
    const root = await setup(t), file = path.join(root, name)
    const before = await readGodotShaderFile(file, options)
    const original = await readFile(before.shader.path)
    const ops = [{ find: "void fragment()", replace: "// temporary\nvoid fragment()", expect: 1 }, { delete_lines: [3, 3] as [number, number], expected_text: "// temporary\n", expect: 1 }, patch]
    const dry = await patchGodotShaderFile(file, ops, { ...options, expectedHash: before.shader.hash, dryRun: true })
    assert.equal(dry.dry_run, true)
    assert.match(dry.expected_diff, /vec3\(0\.5\)/)
    assert.deepEqual(await readFile(before.shader.path), original)
    const applied = await patchGodotShaderFile(file, ops, { ...options, expectedHash: before.shader.hash })
    assert.equal(applied.validation.post_write_shader, true)
    const changed = await readFile(before.shader.path)
    await assert.rejects(() => patchGodotShaderFile(file, [patch], { ...options, expectedHash: before.shader.hash }), { code: "SHADER_HASH_MISMATCH" })
    await assert.rejects(() => patchGodotShaderFile(file, [{ find: "absent_literal", replace: "", expect: 1 }], options), { code: "PATCH_EXPECT_MISMATCH" })
    assert.deepEqual(await readFile(before.shader.path), changed)
    assert.equal((await readGodotShaderFile(file, options)).shader.hash, applied.after.shader_hash)
    await reload(root, name)
  })
}

for (const name of ["embedded.res", "compressed.res", "embedded.tres", "external.res", "external.tres"]) {
  test(`4.x parity: material parameters, resource hashes and parameter diff: ${name}`, { skip: !engine }, async t => {
    const root = await setup(t), file = path.join(root, name)
    const baseline = path.join(root, "before" + path.extname(name))
    await cp(file, baseline)
    const before = await readGodotShaderFile(file, options)
    assert.ok(before.resource_hash)
    assert.equal((await readGodotShaderFile(file, { ...options, params: false })).params, undefined)
    const codeBefore = await readFile(before.shader.path)
    const color = [0.125, 0.25, 0.5, 1]
    await patchGodotShaderFile(file, [set("tint", color, { expected_value: before.params!.materials.at(-1)!.properties[0]!.value })], { ...options, expectedResourceHash: before.resource_hash })
    const after = await readGodotShaderFile(file, options)
    assert.deepEqual(after.params!.materials.at(-1)!.properties[0]!.value, color)
    assert.equal(after.shader.code, before.shader.code)
    if (before.shader.source === "external") assert.deepEqual(await readFile(before.shader.path), codeBefore)
    const diff = await diffGodotMaterials(baseline, file, options, options)
    assert.equal(diff.equal, false)
    assert.equal(diff.shader.changed, false)
    assert.equal(diff.parameter_diff.length, 1)
    assert.equal(diff.parameter_diff[0]!.parameter, "root/tint")
    await assert.rejects(() => patchGodotShaderFile(file, [set("tint", [1, 1, 1, 1])], { ...options, expectedResourceHash: before.resource_hash }), { code: "RESOURCE_HASH_MISMATCH" })
    await reload(root, name, color)
  })
}

test("4.x text params preserve comments/metadata; sequential and mixed patches remain atomic", { skip: !engine }, async t => {
  const root = await setup(t), file = path.join(root, "embedded.tres")
  const text = '; preserved header\r\n' + (await readFile(file, "utf8")).replace(/\n/g, "\r\n") + '; unchanged trailer\r\n'
  await writeFile(file, text)
  const original = await readFile(file)
  await assert.rejects(() => patchGodotShaderFile(file, [set("tint", [1, 0, 0, 1]), set("missing", 1)], options), { code: "PATCH_EXPECT_MISMATCH" })
  assert.deepEqual(await readFile(file), original)
  await patchGodotShaderFile(file, [set("tint", [1, 0, 0, 1]), set("tint", [0, 1, 0, 1], { expected_value: [1, 0, 0, 1] }), patch], options)
  const output = await readFile(file, "utf8")
  assert.ok(output.startsWith('; preserved header\r\n'))
  assert.ok(output.endsWith('; unchanged trailer\r\n'))
  const a = inspectTextResource(text), b = inspectTextResource(output)
  assert.equal(a.sections.at(-1)!.properties.get("metadata/types")!.raw, b.sections.at(-1)!.properties.get("metadata/types")!.raw)
  await reload(root, "embedded.tres", [0, 1, 0, 1])
})

test("4.x text external param edits keep shared Shader intact and mixed two-file edits fail closed", { skip: !engine }, async t => {
  const root = await setup(t), file = path.join(root, "external.tres"), shader = path.join(root, "external.gdshader")
  const shaderBytes = await readFile(shader)
  const original = await readFile(file)
  await assert.rejects(() => patchGodotShaderFile(file, [set("tint", [1, 0, 0, 1]), patch], options), { code: "INVALID_PATCH" })
  assert.deepEqual(await readFile(file), original)
  await patchGodotShaderFile(file, [set("tint", [1, 0, 0, 1])], options)
  assert.deepEqual(await readFile(shader), shaderBytes)
})

test("4.x text texture bindings compare by path rather than resource IDs", async t => {
  const root = await setup(t), source = await readFile(path.join(root, "embedded.tres"), "utf8")
  const fixture = (id: string, texture: string) => source.replace('[sub_resource', `[ext_resource type="Texture2D" path="${texture}" id="${id}"]\n\n[sub_resource`).replace('[resource]', `[resource]\nshader_parameter/Tex = ExtResource("${id}")`)
  const a = path.join(root, "a.tres"), b = path.join(root, "b.tres")
  await writeFile(a, fixture("Tex_first", "res://missing-but-not-opened.png"))
  await writeFile(b, fixture("Tex_second", "res://missing-but-not-opened.png"))
  assert.equal((await diffGodotMaterials(a, b)).equal, true)
  await writeFile(b, fixture("Tex_second", "res://different.png"))
  const diff = await diffGodotMaterials(a, b)
  assert.equal(diff.parameter_diff.length, 1)
  assert.equal(diff.parameter_diff[0]!.parameter, "root/Tex")
})

test("4.x text multiple materials enforce counts and allow internal-resource targeting", { skip: !engine }, async t => {
  const root = await setup(t), file = path.join(root, "embedded.tres")
  const source = await readFile(file, "utf8")
  const shader = inspectTextResource(source).sections[0]!.attributes.get("id")!.value
  await writeFile(file, source.replace('[resource]', `[sub_resource type="ShaderMaterial" id="Material_next"]\nshader = SubResource("${shader}")\nshader_parameter/tint = Color(1, 0, 0, 1)\n\n[resource]\nnext_pass = SubResource("Material_next")`))
  await assert.rejects(() => patchGodotShaderFile(file, [set("tint", [0, 1, 0, 1])], options), { code: "PATCH_EXPECT_MISMATCH" })
  await patchGodotShaderFile(file, [set("tint", [0, 1, 0, 1], { internal_resource_index: 1 })], options)
  const materials = (await readGodotShaderFile(file)).params!.materials
  assert.deepEqual(materials[0]!.properties[0]!.value, [0, 1, 0, 1])
  assert.notDeepEqual(materials[1]!.properties[0]!.value, [0, 1, 0, 1])
  await patchGodotShaderFile(file, [set("tint", [0, 0, 1, 1], {}, 2)], options)
  await reload(root, "embedded.tres", [0, 0, 1, 1])
})

test("4.x packed/new Variant parameter edits and double precision are retained", { skip: !engine }, async t => {
  const root = await setup(t), file = path.join(root, "rich.res")
  const parsed = parseResource(await readFile(path.join(root, "embedded.res")))
  const target = parsed.resource.parsedInternalResources.at(-1)!
  const values = [
    ["point", "vector4", 50, [1, 2, 3, 4], [4, 3, 2, 1]],
    ["axis", "vector3i", 47, [1, 2, 3], [-1, 0, 1]],
    ["points", "vector4_array", 53, [[1, 2, 3, 4]], [[4, 3, 2, 1], [1, 1, 1, 1]]],
    ["weights", "real_array", 33, [1, 2], [0.1, 0.2]],
  ] as const
  for (const [name, type, type_id, value] of values) target.properties.push({ name: `shader_parameter/${name}`, offset: 0, value: { type, type_id, value } })
  await writeFile(file, serializeResource(parsed))
  await patchGodotShaderFile(file, values.map(([name, , , , value]) => set(name, value)), options)
  const params = (await readGodotShaderFile(file)).params!.materials[0]!.properties
  assert.deepEqual(params.find(p => p.name === "point")!.value, [4, 3, 2, 1])
  assert.deepEqual(params.find(p => p.name === "weights")!.value, [0.1, 0.2].map(Math.fround))
  assert.deepEqual(params.find(p => p.name === "points")!.value, [[4, 3, 2, 1], [1, 1, 1, 1]])
  const precision = parseResource(await readFile(file))
  precision.resource.reservedFields[0]! |= 4
  precision.resource.parsedInternalResources.at(-1)!.properties.push({ name: "shader_parameter/doubleReal", offset: 0, value: { type: "real", type_id: 4, value: 1.25 } })
  await writeFile(file, serializeResource(precision))
  await patchGodotShaderFile(file, [set("doubleReal", 0.123456789012345)], options)
  assert.equal((await readGodotShaderFile(file)).params!.materials[0]!.properties.find(p => p.name === "doubleReal")!.value, 0.123456789012345)
})

test("4.x mixed-version batch entries select their own compiler and continue after failure", { skip: !engine }, async t => {
  const root = await setup(t)
  await writeFile(path.join(root, "legacy.material"), minimalShaderMaterial("shader_type spatial; void fragment(){ ALBEDO=vec3(1.0); }"))
  const plan = [
    { path: "legacy.material", ops: [{ find: "vec3(1.0)", replace: "vec3(0.5)", expect: 1 }], godot_version: "3.6", renderer: "gles3" },
    { path: "embedded.tres", ops: [{ find: "not found", replace: "", expect: 1 }] },
    { path: "external.gdshader", ops: [patch], godot_version: "4.x", renderer: "dummy" },
    { path: "compressed.res", ops: [set("tint", [1, 0, 0, 1])] },
  ]
  await writeFile(path.join(root, "plan.json"), JSON.stringify(plan))
  const result = await applyShaderPlan(path.join(root, "plan.json"), options)
  assert.deepEqual(result.summary, { total: 4, succeeded: 3, failed: 1 })
  assert.equal((result.results[1]!.error as any).code, "PATCH_EXPECT_MISMATCH")
})

test("4.x text Vector4/ivec3/packed arrays are edited and confirmed by the official resource loader", { skip: !engine }, async t => {
  const root = await setup(t), file = path.join(root, "rich.tres")
  const source = (await readFile(path.join(root, "embedded.tres"), "utf8"))
    .replace("uniform vec4 tint", "uniform vec4 point;\nuniform ivec3 axis;\nuniform float weights[2];\nuniform vec4 tint") +
    '\nshader_parameter/point = Vector4(1, 2, 3, 4)\nshader_parameter/axis = Vector3i(1, 2, 3)\nshader_parameter/weights = PackedFloat32Array(1, 2)\n'
  await writeFile(file, source)
  await patchGodotShaderFile(file, [set("point", [4, 3, 2, 1]), set("axis", [-1, 0, 1]), set("weights", [0.125, 0.25])])
  await reload(root, "rich.tres", undefined, [
    'r.get_shader_parameter("point") == Vector4(4, 3, 2, 1)',
    'r.get_shader_parameter("axis") == Vector3i(-1, 0, 1)',
    'r.get_shader_parameter("weights") == PackedFloat32Array([0.125, 0.25])',
  ])
})

test("text parameter rewrites preserve existing BOM, signed zero, Unicode and untouched syntax", async t => {
  const root = await setup(t)
  const text = '\uFEFF' + await readFile(path.join(root, "embedded.tres"), "utf8") + '\nshader_parameter/label = &"old"\nshader_parameter/large = 9223372036854775807\n'
  const source = inspectTextResource(text).code!
  const prepared = prepareMaterialWrite(new TextEncoder().encode(text), source, source, [set("tint", [-0, 0.5, 0.25, 1]), set("label", '中文 "label"'), set("large", "-9223372036854775808")], {})
  assert.equal(prepared.verify(prepared.bytes), source)
  const written = new TextDecoder("utf-8", { ignoreBOM: true }).decode(prepared.bytes)
  assert.ok(written.startsWith("\uFEFF"))
  assert.match(written, /Color\(-0\.0,/)
  assert.match(written, /shader_parameter\/large = -9223372036854775808/)
  assert.throws(() => prepareMaterialWrite(new TextEncoder().encode(text), source, source, [set("label", "\ud800")], {}))
})

test("4.x batch preflight detects shared targets and preserves dry-run originals", { skip: !engine }, async t => {
  const root = await setup(t), plan = path.join(root, "plan.json")
  await writeFile(plan, JSON.stringify([{ path: "external.res", ops: [patch] }, { path: "external.tres", ops: [patch] }]))
  const conflicts = await applyShaderPlan(plan, options)
  assert.equal(conflicts.summary.failed, 2)
  assert.ok(conflicts.results.every(r => (r.error as any).code === "DUPLICATE_WRITE_TARGET"))
  await writeFile(plan, JSON.stringify([{ path: "embedded.tres", ops: [set("tint", [1, 0, 0, 1])] }]))
  const before = await readFile(path.join(root, "embedded.tres"))
  const dry = await applyShaderPlan(plan, { ...options, dryRun: true })
  assert.equal(dry.summary.succeeded, 1)
  assert.deepEqual(await readFile(path.join(root, "embedded.tres")), before)
})

test("4.x search, regex pagination, hashes and partial source metadata retain 3.x behavior", async t => {
  const root = await setup(t)
  const found = await searchGodotShaders("tint", root, { ...options, max_matches: 2 })
  assert.equal(found.success, true)
  assert.equal(found.matches.length, 2)
  assert.equal(found.truncated, true)
  const next = await searchGodotShaders("tint", root, { ...options, offset: 2, max_matches: 2, regex: true })
  assert.equal(next.matches.length, 2)
  const read = await readGodotShaderFile(path.join(root, "embedded.tres"))
  const view = sourceView(read, { start_line: 2, end_line: 2 })
  assert.match(view.shader.code!, /source_color/)
  assert.equal(view.shader.hash, read.shader.hash)
  assert.equal("code" in sourceView(read, { metadata_only: true }).shader, false)
})
