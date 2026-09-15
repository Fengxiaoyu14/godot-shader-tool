import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdDecompressSync } from "node:zlib"

import { readGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-reader.ts"
import { GodotReaderError } from "../../.opencode/tools/godot_shader_reader/errors.ts"
import { writeGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-writer.ts"
import { readGodot36Shader } from "../../.opencode/tools/godot_shader_reader/index.ts"
import { validateShaderRequest } from "../../.opencode/tools/godot_shader_reader/validation-tool.ts"
import { buildBinaryResource, buildRscc, externalShaderMaterial, minimalShaderMaterial, variantString } from "./fixture-builder.ts"

const code = 'shader_type spatial;\r\n// 中文 "quoted" \\path\r\nvoid fragment() { ALBEDO = vec3(1.0); }\r\n'
const textShader = (source = code) => `[gd_resource type="Shader" format=2]\n\n[resource]\ncode = ${JSON.stringify(source)}\n`
const hasCode = (code: string) => (error: unknown): boolean => error instanceof GodotReaderError && error.code === code

async function project(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "godot-external-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "materials"))
  await mkdir(path.join(root, "shaders"))
  await writeFile(path.join(root, "project.godot"), "config_version=4\n")
  const material = path.join(root, "materials/test.material")
  const shader = path.join(root, "shaders/shared.tres")
  await writeFile(material, externalShaderMaterial())
  await writeFile(shader, textShader())
  return { root, material, shader }
}

test("indexed external Shader resolves project root from material, preserving code and provenance", async (t) => {
  const { root, material, shader } = await project(t)
  const materialBefore = await readFile(material)
  const shaderBefore = await readFile(shader)
  const result = await readGodotShaderFile(material)
  assert.equal(result.shader.code, code)
  assert.equal(result.shader.source, "external")
  assert.equal(result.shader.path, shader.split(path.sep).join("/"))
  assert.equal(result.shader.project_root, root.split(path.sep).join("/"))
  assert.equal(result.shader.external_resource_index, 0)
  assert.equal(result.shader.resource_path, "res://shaders/shared.tres")
  assert.equal(result.shader.overridden, false)
  assert.equal(result.shader.subindex, undefined)
  assert.deepEqual(await readFile(material), materialBefore)
  assert.deepEqual(await readFile(shader), shaderBefore)
})

test("RSCC material follows legacy inline external reference", async (t) => {
  const { material } = await project(t)
  await writeFile(material, buildRscc(externalShaderMaterial("../shaders/shared.tres", {
    inline: true, includeMagicHeader: false,
  }), 128))
  const result = await readGodotShaderFile(material, { zstdDecoder: zstdDecompressSync })
  assert.equal(result.shader.code, code)
  assert.equal(result.container.format, "RSCC")
  assert.equal(result.shader.external_resource_index, undefined)
})

test("explicit project root works without project.godot and overrides auto discovery", async (t) => {
  const { root, material } = await project(t)
  await rm(path.join(root, "project.godot"))
  assert.equal((await readGodotShaderFile(material, { projectRoot: root })).shader.code, code)
  await assert.rejects(() => readGodotShaderFile(material, { projectRoot: path.join(root, "missing") }), hasCode("PROJECT_ROOT_NOT_FOUND"))
})

test("nearest project root wins over an ancestor project", async (t) => {
  const { root, material } = await project(t)
  const nested = path.dirname(material)
  await writeFile(path.join(nested, "project.godot"), "config_version=4\n")
  await mkdir(path.join(nested, "shaders"))
  await writeFile(path.join(nested, "shaders/shared.tres"), textShader("shader_type canvas_item;"))
  assert.equal((await readGodotShaderFile(material)).shader.code, "shader_type canvas_item;")
  assert.equal((await readGodotShaderFile(material, { projectRoot: root })).shader.code, code)
})

test("missing root gives an actionable error; renamed dependency override works without root", async (t) => {
  const { root, material, shader } = await project(t)
  await rm(path.join(root, "project.godot"))
  await assert.rejects(() => readGodotShaderFile(material), (error: unknown) =>
    error instanceof GodotReaderError && error.code === "PROJECT_ROOT_NOT_FOUND" &&
    error.details?.dependency_path === "res://shaders/shared.tres")
  const renamed = path.join(root, "uploaded.tres")
  await writeFile(renamed, await readFile(shader))
  await rm(shader)
  const result = await readGodotShaderFile(material, { shaderPath: renamed })
  assert.equal(result.shader.code, code)
  assert.equal(result.shader.overridden, true)
  assert.equal(result.shader.path, renamed.split(path.sep).join("/"))
})

test("missing dependency reports original reference and attempted filesystem path", async (t) => {
  const { material, shader } = await project(t)
  await rm(shader)
  await assert.rejects(() => readGodotShaderFile(material), (error: unknown) =>
    error instanceof GodotReaderError && error.code === "DEPENDENCY_NOT_FOUND" &&
    error.details?.dependency_path === "res://shaders/shared.tres" &&
    error.details?.resolved_path === shader.split(path.sep).join("/"))
  await mkdir(shader)
  await assert.rejects(() => readGodotShaderFile(material), hasCode("DEPENDENCY_NOT_FOUND"))
})

test("absolute Shader reference is supported", async (t) => {
  const { material, shader } = await project(t)
  await writeFile(material, externalShaderMaterial(shader))
  assert.equal((await readGodotShaderFile(material)).shader.code, code)
})

test("unknown resource schemes and foreign absolute paths are not guessed", async (t) => {
  const { material, shader } = await project(t)
  const paths = ["user://shared.tres", "https://example.test/shader", ""]
  if (process.platform !== "win32") paths.push("D:/project/shader.tres")
  for (const ref of paths) {
    await writeFile(material, externalShaderMaterial(ref))
    await assert.rejects(() => readGodotShaderFile(material), hasCode("UNSUPPORTED_RESOURCE_PATH"))
    assert.equal((await readGodotShaderFile(material, { shaderPath: shader })).shader.code, code)
  }
})

test("wrong external type and out-of-range index fail explicitly", async (t) => {
  const { material } = await project(t)
  await writeFile(material, externalShaderMaterial(undefined, { type: "Texture" }))
  await assert.rejects(() => readGodotShaderFile(material), hasCode("NOT_SHADER_RESOURCE"))
  await writeFile(material, externalShaderMaterial(undefined, { index: 9 }))
  await assert.rejects(() => readGodotShaderFile(material), hasCode("INVALID_BINARY_RESOURCE"))
})

test("external file must actually contain Shader; no recursive material chasing", async (t) => {
  const { material, shader } = await project(t)
  await writeFile(shader, '[gd_resource type="ShaderMaterial" format=2]\n[resource]\ncode = "fake"')
  await assert.rejects(() => readGodotShaderFile(material), hasCode("NOT_SHADER_RESOURCE"))
  await writeFile(shader, await readFile(material))
  await assert.rejects(() => readGodotShaderFile(material), hasCode("NOT_SHADER_RESOURCE"))
})

test("standalone text, source and binary Shader reads, including compressed dependency", async (t) => {
  const { root, material, shader } = await project(t)
  const direct = await readGodotShaderFile(shader)
  assert.equal(direct.shader.code, code)
  assert.equal(direct.shader.source, "standalone")
  assert.equal(direct.container.format, "text")
  for (const extension of ["shader", "gdshader"]) {
    const raw = path.join(root, `shared.${extension}`)
    await writeFile(raw, "\uFEFF" + code)
    await writeFile(material, externalShaderMaterial(raw))
    assert.equal((await readGodotShaderFile(raw)).shader.code, code)
    assert.equal((await readGodotShaderFile(material)).shader.code, code)
  }
  await writeFile(material, externalShaderMaterial())
  for (const compressed of [false, true]) {
    const binary = buildBinaryResource("Shader", [{ path: "res://shared.res", type: "Shader",
      properties: [{ name: "code", value: variantString(code) }] }], !compressed)
    await writeFile(shader, compressed ? buildRscc(binary, 128) : binary)
    const options = { zstdDecoder: zstdDecompressSync }
    assert.equal((await readGodotShaderFile(material, options)).shader.code, code)
    assert.equal((await readGodotShaderFile(shader, options)).shader.code, code)
  }
})

test("existing embedded result fields are preserved; unused override is rejected", async (t) => {
  const { material, shader } = await project(t)
  const bytes = minimalShaderMaterial(code)
  await writeFile(material, bytes)
  const expected = readGodot36Shader(bytes)
  const actual = await readGodotShaderFile(material)
  assert.deepEqual(actual.resource, expected.resource)
  assert.deepEqual(actual.container, expected.container)
  for (const [key, value] of Object.entries(expected.shader)) assert.equal(actual.shader[key as keyof typeof expected.shader], value)
  await assert.rejects(() => readGodotShaderFile(material, { shaderPath: shader }), hasCode("INVALID_READ_ARGUMENTS"))
  await assert.rejects(() => readGodotShaderFile(shader, { shaderPath: shader }), hasCode("INVALID_READ_ARGUMENTS"))
})

test("byte-only reader reports external dependency instead of SHADER_NOT_FOUND", () => {
  assert.throws(() => readGodot36Shader(externalShaderMaterial()), (error: unknown) =>
    error instanceof GodotReaderError && error.code === "EXTERNAL_SHADER_REQUIRES_FILE" &&
    error.details?.dependency_path === "res://shaders/shared.tres")
})

test("writer follows external reference, returns actual path and preserves the material", async (t) => {
  const { material, shader } = await project(t)
  const materialBefore = await readFile(material)
  const directoryBefore = await readdir(path.dirname(material))
  const replacement = "shader_type spatial;\n// updated shared Shader\n"
  const result = await writeGodotShaderFile(material, replacement)
  assert.equal(result.written_path, shader.split(path.sep).join("/"))
  assert.equal(result.shared_shader, true)
  assert.equal((await readGodotShaderFile(material)).shader.code, replacement)
  assert.deepEqual(await readFile(material), materialBefore)
  assert.deepEqual(await readdir(path.dirname(material)), directoryBefore)
})

test("validation uses external file resolution and native validator from unrelated worktree", async (t) => {
  const { root, material, shader } = await project(t)
  assert.equal((await validateShaderRequest({ path: material }, tmpdir())).valid, true)
  await rm(path.join(root, "project.godot"))
  assert.equal((await validateShaderRequest({ path: material, project_root: "." }, root)).valid, true)
  assert.equal((await validateShaderRequest({ path: material, shader_path: "shaders/shared.tres" }, root)).valid, true)
  await writeFile(shader, textShader("shader_type spatial;\nvoid fragment() { ALBEDO = missing_value; }"))
  assert.equal((await validateShaderRequest({ path: material, shader_path: shader }, tmpdir())).valid, false)
  await assert.rejects(() => validateShaderRequest({ shader_code: code, shader_path: shader }, root), hasCode("INVALID_VALIDATE_ARGUMENTS"))
})

test("malformed dependency carries file provenance; UTF-8 corruption is not silently replaced", async (t) => {
  const { material, shader } = await project(t)
  await writeFile(shader, '[gd_resource type="Shader" format=2]\n[resource]\ncode = "unterminated')
  await assert.rejects(() => readGodotShaderFile(material), (error: unknown) =>
    error instanceof GodotReaderError && error.code === "INVALID_TEXT_RESOURCE" &&
    error.details?.dependency_path === "res://shaders/shared.tres" && error.line === 3)
  await writeFile(shader, new Uint8Array([0xff, 0xfe, 0xff]))
  await assert.rejects(() => readGodotShaderFile(material), hasCode("INVALID_UTF8"))
})

test("missing input and directory input report FILE_NOT_FOUND", async (t) => {
  const { root } = await project(t)
  await assert.rejects(() => readGodotShaderFile(root), hasCode("FILE_NOT_FOUND"))
  await assert.rejects(() => readGodotShaderFile(path.join(root, "missing.material")), hasCode("FILE_NOT_FOUND"))
})
