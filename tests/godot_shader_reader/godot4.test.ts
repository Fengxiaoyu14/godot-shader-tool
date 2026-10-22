import assert from "node:assert/strict"
import test from "node:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { readGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-reader.ts"
import { writeGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-writer.ts"
import { parseResource, serializeResource, rewriteShaderCode } from "../../.opencode/tools/godot_shader_reader/codec.ts"
import { validateShaderRequest } from "../../.opencode/tools/godot_shader_reader/validation-tool.ts"
import { validateGodot4Shader } from "../../.opencode/tools/godot_shader_reader/validator4.ts"
import { createShaderValidator } from "../../.opencode/tools/godot_shader_reader/validator.ts"
import { inspectTextResource } from "../../.opencode/tools/godot_shader_reader/text-shader.ts"

const fixtures = fileURLToPath(new URL("./fixtures/godot4/", import.meta.url))
const options = { zstdDecoder: zstdDecompressSync, zstdEncoder: zstdCompressSync }
const replacement = "shader_type spatial;\nuniform vec4 tint : source_color = vec4(1.0);\nvoid fragment() { ALBEDO = tint.rgb * 0.5; }\n// 中文\n"
const engine = process.env.GODOT4_BIN

for (const name of ["embedded.res", "compressed.res", "embedded.tres", "standalone.res", "standalone.tres", "external.res", "external.tres", "external.gdshader"]) {
  test(`Godot 4 official fixture reads ${name}`, async () => {
    const result = await readGodotShaderFile(path.join(fixtures, name), options)
    assert.match(result.shader.code, /source_color/)
    assert.equal(result.shader.source, name.startsWith("external.") && !name.endsWith("gdshader") ? "external" : name.startsWith("standalone") || name.endsWith("gdshader") ? "standalone" : "embedded")
    if (name === "embedded.res") {
      assert.equal(result.resource.version_major, 4)
      assert.equal(result.params!.materials[0]!.properties[0]!.name, "tint")
      assert.equal(result.params!.materials[0]!.uniforms[0]!.assigned, true)
    }
  })
}

test("Godot 4 binary roundtrip preserves UIDs, named IDs and all metadata Variants", async () => {
  for (const name of ["embedded.res", "compressed.res", "standalone.res"]) {
    const original = await readFile(path.join(fixtures, name))
    const result = rewriteShaderCode(original, replacement, options.zstdDecoder, options.zstdEncoder)
    assert.equal(result.after.resource.versionMajor, 4)
    assert.deepEqual(result.after.resource.reservedFields, result.before.resource.reservedFields)
    assert.deepEqual(result.after.resource.externalResources, result.before.resource.externalResources)
    assert.equal(result.validation.only_shader_changed, true)
  }
})

test("Godot 4 text reader handles typed metadata, StringName and Unicode escapes", () => {
  const result = inspectTextResource('[gd_resource type="ShaderMaterial" format=3]\n[sub_resource type="Shader" id="Shader_1"]\ncode="shader_type spatial;\\U01f600"\n[resource]\nshader=SubResource("Shader_1")\nmetadata/a=Array[StringName]([&"a"])\n')
  assert.equal(result.type, "ShaderMaterial")
  assert.equal(result.code, "shader_type spatial;😀")
})

test("Godot 4 header script class and real_t double precision roundtrip", async () => {
  const parsed = parseResource(await readFile(path.join(fixtures, "embedded.res")))
  parsed.resource.reservedFields[0]! |= 8 | 4
  parsed.resource.scriptClass = "CustomMaterial"
  parsed.resource.parsedInternalResources.at(-1)!.properties.push({ name: "metadata/real", offset: 0, value: { type: "real", type_id: 4, value: 1.125 } })
  const bytes = serializeResource(parsed)
  const written = rewriteShaderCode(bytes, replacement)
  assert.equal(written.after.resource.scriptClass, "CustomMaterial")
  assert.equal(written.after.resource.reservedFields[0]! & 12, 12)
  assert.equal(written.validation.only_shader_changed, true)
})

test("Godot 4 validation requires a real engine and rejects unsupported renderer profiles", async () => {
  await assert.rejects(() => validateGodot4Shader(replacement, { executablePath: path.join(fixtures, "absent-engine") }), { code: "SHADER_VALIDATOR_UNAVAILABLE" })
  assert.throws(() => createShaderValidator({ godotVersion: "4.x", renderer: "forward_plus" }), { code: "UNSUPPORTED_VALIDATOR_PROFILE" })
})

test("Godot 4 official compiler accepts five shader types and rejects 3.x hints and invalid source", { skip: !engine }, async () => {
  for (const source of [replacement, "shader_type canvas_item; void fragment(){ COLOR = vec4(1.0); }", "shader_type particles; void process(){ VELOCITY = vec3(0.0); }", "shader_type sky; void sky(){ COLOR = vec3(0.2); }", "shader_type fog; void fog(){ DENSITY = 0.5; }"]) {
    const result = await validateShaderRequest({ shader_code: source, godot_version: "4.x" }, fixtures)
    assert.equal(result.valid, true)
    assert.equal(result.renderer, "dummy")
    assert.match(result.godot_version, /^4\./)
  }
  for (const source of ["shader_type spatial;\nvoid fragment(){ALBEDO=missing;}", "shader_type spatial; uniform vec4 c : hint_color;", "shader_type spatial; void fragment( { }", "shader_type spatial; render_mode not_a_render_mode;"]) {
    const result = await validateGodot4Shader(source)
    assert.equal(result.valid, false)
    if (!result.valid) { assert.ok(result.error.line >= 1); assert.ok(result.error.message) }
  }
  await assert.rejects(() => validateGodot4Shader(replacement, { godotVersion: "4.0" }), { code: "UNSUPPORTED_VALIDATOR_PROFILE" })
  await assert.rejects(() => validateGodot4Shader(replacement, { timeoutMs: 1 }), { code: "SHADER_VALIDATOR_TIMEOUT" })
  const auto = await validateShaderRequest({ path: path.join(fixtures, "embedded.tres"), renderer: "dummy" }, fixtures)
  assert.equal(auto.valid, true)
  await assert.rejects(() => validateShaderRequest({ path: path.join(fixtures, "embedded.res"), godot_version: "3.6" }, fixtures), { code: "UNSUPPORTED_VALIDATOR_PROFILE" })
})

for (const name of ["embedded.res", "compressed.res", "embedded.tres", "standalone.res", "standalone.tres", "external.res", "external.tres", "external.gdshader"]) {
  test(`Godot 4 real pre/post validation, write and engine reload: ${name}`, { skip: !engine }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "godot4-write-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    await cp(fixtures, root, { recursive: true })
    const target = path.join(root, name)
    const original = await readFile(target)
    const read = await readGodotShaderFile(target, options)
    const profile = name.endsWith("gdshader") ? { godotVersion: "4.x" } : {}
    const result = await writeGodotShaderFile(target, replacement, { ...options, ...profile })
    assert.equal(result.validation.post_write_shader, true)
    assert.equal((await readGodotShaderFile(target, options)).shader.code, replacement)
    if (read.shader.source === "external") assert.deepEqual(await readFile(target), original)
    const replaced = await readFile(result.written_path)
    await assert.rejects(() => writeGodotShaderFile(target, "shader_type spatial; void fragment(){ ALBEDO=missing; }", { ...options, ...profile }), { code: "SHADER_VALIDATION_FAILED" })
    assert.deepEqual(await readFile(result.written_path), replaced)
    const dryRun = await writeGodotShaderFile(target, replacement + "// dry run", { ...options, ...profile, dryRun: true })
    assert.equal(dryRun.dry_run, true)
    assert.deepEqual(await readFile(result.written_path), replaced)
    await writeFile(path.join(root, "reload.gd"), 'extends SceneTree\nfunc _initialize():\n var r = load("res://' + name + '")\n if r == null:\n  quit(2)\n  return\n var s = r.shader if r is ShaderMaterial else r\n print("RELOADED:" + s.code.sha256_text())\n quit()\n')
    const loaded = spawnSync(engine!, ["--headless", "--path", root, "--script", "reload.gd"], { encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, APPDATA: root, XDG_DATA_HOME: root, GODOT_SILENCE_ROOT_WARNING: "1" } })
    assert.equal(loaded.status, 0, loaded.stderr)
    assert.match(loaded.stdout, new RegExp("RELOADED:" + result.after.shader_hash))
    assert.doesNotMatch(loaded.stderr, /(?:ERROR|Error):/)
  })
}
