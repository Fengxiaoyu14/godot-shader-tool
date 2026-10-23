import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { parseResource, rewriteShaderCode } from "../../.opencode/tools/godot_shader_reader/codec.ts"
import { readGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-reader.ts"
import { writeGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-writer.ts"
import { GodotReaderError } from "../../.opencode/tools/godot_shader_reader/errors.ts"
import { inspectTextShader } from "../../.opencode/tools/godot_shader_reader/text-shader.ts"
import { prepareShaderWrite } from "../../.opencode/tools/godot_shader_reader/shader-rewrite.ts"
import { serializeBinaryResource } from "../../.opencode/tools/godot_shader_reader/resource-writer.ts"
import { buildBinaryResource, buildRscc, externalShaderMaterial, minimalShaderMaterial, variantString } from "./fixture-builder.ts"

const originalCode = "shader_type spatial;\r\n// original\r\n"
const replacement = 'shader_type spatial;\r\n// 中文 "quoted" \\path\r\n' + "// longer\n".repeat(600)
const options = { zstdDecoder: zstdDecompressSync, zstdEncoder: zstdCompressSync }
const hasCode = (code: string) => (error: unknown): boolean => error instanceof GodotReaderError && error.code === code

function version(bytes: Uint8Array, minor: number, compressed: boolean): Uint8Array {
  const copy = bytes.slice()
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(16, minor, true)
  if (!compressed) return copy
  const model = parseResource(copy).resource
  return buildRscc(serializeBinaryResource(model, { includeMagicHeader: false }), 128)
}

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "godot-write-compat-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// Hypothetical later minors verify that no minor-version allowlist remains.
for (const minor of [0, 1, 2, 3, 4, 5, 6, 7, 99]) {
  for (const compressed of [false, true]) {
    test(`Godot 3.${minor} ${compressed ? "RSCC" : "RSRC"} embedded read/write preserves version and metadata`, async (t) => {
      const root = await directory(t)
      const file = path.join(root, "test.material")
      const original = version(minimalShaderMaterial(originalCode), minor, compressed)
      await writeFile(file, original)
      for (const code of [originalCode, "shader_type spatial;", replacement]) {
        await writeGodotShaderFile(file, code, options)
        const readBack = await readGodotShaderFile(file, options)
        assert.equal(readBack.shader.code, code)
        assert.equal(("version_minor" in readBack.resource ? readBack.resource.version_minor : undefined), minor)
        assert.equal(readBack.container.format, compressed ? "RSCC" : "RSRC")
      }
      const final = parseResource(await readFile(file), zstdDecompressSync)
      assert.equal(final.resource.formatVersion, 3)
      assert.deepEqual(final.resource.externalResources, parseResource(original, zstdDecompressSync).resource.externalResources)
    })

    test(`Godot 3.${minor} ${compressed ? "RSCC" : "RSRC"} standalone binary Shader writes through external material`, async (t) => {
      const root = await directory(t)
      const material = path.join(root, "test.material")
      const shader = path.join(root, "shared.res")
      const materialBytes = version(externalShaderMaterial("shared.res"), minor, compressed)
      await writeFile(material, materialBytes)
      const bytes = buildBinaryResource("Shader", [{ path: "res://shared.res", type: "Shader", properties: [
        { name: "resource_name", value: variantString("unchanged metadata") },
        { name: "code", value: variantString(originalCode) },
      ] }])
      await writeFile(shader, version(bytes, minor, compressed))
      const result = await writeGodotShaderFile(material, replacement, options)
      assert.equal(result.source, "external")
      assert.equal(result.written_path, shader.split(path.sep).join("/"))
      assert.deepEqual(await readFile(material), materialBytes)
      assert.equal((await readGodotShaderFile(material, options)).shader.code, replacement)
      const model = parseResource(await readFile(shader), zstdDecompressSync).resource
      assert.equal(model.versionMinor, minor)
      assert.equal(model.parsedInternalResources[0]!.properties[0]!.value.value, "unchanged metadata")
    })
  }
}

test("unsupported major/format are rejected by both reader and writer", () => {
  for (const [major, minor, format] of [[2, 1, 3], [5, 0, 3], [3, 0, 2], [3, 6, 4], [3, 99, 4]]) {
    const bytes = minimalShaderMaterial()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(12, major, true)
    view.setUint32(16, minor, true)
    view.setUint32(20, format, true)
    assert.throws(() => parseResource(bytes), hasCode("UNSUPPORTED_RESOURCE_VERSION"))
    const model = parseResource(minimalShaderMaterial()).resource
    Object.assign(model, { versionMajor: major, versionMinor: minor, formatVersion: format })
    assert.throws(() => serializeBinaryResource(model, { includeMagicHeader: true }), hasCode("UNSUPPORTED_RESOURCE_FOR_WRITE"))
  }
})

test("text write preserves BOM, comments, header, metadata, and every character outside code", async (t) => {
  const root = await directory(t)
  const material = path.join(root, "test.material")
  const shader = path.join(root, "renamed.tres")
  const bytes = version(externalShaderMaterial(), 5, true)
  await writeFile(material, bytes)
  const original = '\uFEFF; header comment\r\n[gd_resource type="Shader" format=2]\r\n\r\n[resource]\r\nresource_name = "metadata"\r\ncode = ' +
    JSON.stringify(originalCode) + '\r\n; after code\r\nmetadata = { "values": [1, 2] }\r\n'
  await writeFile(shader, original)
  const before = inspectTextShader(original)
  await writeGodotShaderFile(material, replacement, { ...options, shaderPath: shader })
  const output = await readFile(shader, "utf8")
  const after = inspectTextShader(output)
  assert.equal(after.code, replacement)
  assert.equal(output.slice(0, after.start), original.slice(0, before.start))
  assert.equal(output.slice(after.end), original.slice(before.end))
  assert.deepEqual(await readFile(material), bytes)
  assert.equal((await readGodotShaderFile(shader)).shader.code, replacement)
})

test("standalone raw and text Shader writes support shorter, longer, Unicode and no-op replacements", async (t) => {
  const root = await directory(t)
  for (const ext of ["shader", "gdshader", "tres"]) {
    const file = path.join(root, `shared.${ext}`)
    const text = ext === "tres" ? '[gd_resource type="Shader" format=2]\n[resource]\ncode=' + JSON.stringify(originalCode) : "\uFEFF" + originalCode
    await writeFile(file, text)
    for (const code of [originalCode, replacement, "shader_type spatial;"]) {
      await writeGodotShaderFile(file, code)
      assert.equal((await readGodotShaderFile(file)).shader.code, code)
    }
  }
})

test("invalid requested source and failed post-validation preserve external originals and remove temps", async (t) => {
  const root = await directory(t)
  const material = path.join(root, "test.material")
  const shader = path.join(root, "shared.shader")
  await writeFile(material, externalShaderMaterial("shared.shader"))
  await writeFile(shader, originalCode)
  const before = await readFile(material)
  await assert.rejects(() => writeGodotShaderFile(material, "shader_type spatial;\nvoid fragment(){ ALBEDO = unknown_name; }"), hasCode("SHADER_VALIDATION_FAILED"))
  let calls = 0
  await assert.rejects(() => writeGodotShaderFile(material, replacement, { shaderValidator: async () => {
    if (++calls === 1) return { valid: true, godot_version: "3.6", renderer: "gles3", shader_type: "spatial" }
    return { valid: false, godot_version: "3.6", renderer: "gles3", error: { line: 1, message: "injected rejection" } }
  } }), hasCode("SHADER_VALIDATION_FAILED"))
  assert.equal(await readFile(shader, "utf8"), originalCode)
  assert.deepEqual(await readFile(material), before)
  assert.deepEqual((await readdir(root)).sort(), ["shared.shader", "test.material"])
})

test("concurrent material or shared Shader edits abort instead of overwriting", async (t) => {
  const root = await directory(t)
  const material = path.join(root, "test.material")
  const shader = path.join(root, "shared.shader")
  for (const mutateMaterial of [false, true]) {
    await writeFile(material, externalShaderMaterial("shared.shader"))
    await writeFile(shader, originalCode)
    let calls = 0
    await assert.rejects(() => writeGodotShaderFile(material, replacement, { shaderValidator: async () => {
      if (++calls === 2) {
        await writeFile(mutateMaterial ? material : shader, mutateMaterial
          ? minimalShaderMaterial("shader_type spatial;") : "shader_type spatial;\n// someone else's edit\n")
      }
      return { valid: true, godot_version: "3.6", renderer: "gles3", shader_type: "spatial" }
    } }), hasCode("UNEXPECTED_RESOURCE_CHANGE"))
    assert.notEqual((await readGodotShaderFile(shader)).shader.code, replacement)
    assert.equal((await readdir(root)).length, 2)
  }
})

test("text verification rejects changes outside code and changed source", () => {
  const input = '[gd_resource type="Shader" format=2]\n[resource]\nresource_name="before"\ncode="shader_type spatial;"'
  const prepared = prepareShaderWrite(new TextEncoder().encode(input), "shared.tres", originalCode, {})
  const output = new TextDecoder().decode(prepared.bytes)
  assert.throws(() => prepared.verify(new TextEncoder().encode(output.replace('resource_name="before"', 'resource_name="after"'))), hasCode("UNEXPECTED_RESOURCE_CHANGE"))
  assert.throws(() => prepared.verify(new TextEncoder().encode(output.replace("spatial", "canvas_item"))), hasCode("SHADER_VERIFY_FAILED"))
  assert.throws(() => rewriteShaderCode(externalShaderMaterial(), originalCode), hasCode("EXTERNAL_SHADER_WRITE_UNSUPPORTED"))
})
