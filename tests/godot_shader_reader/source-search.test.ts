import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { sourceView, shaderHash, unifiedDiff } from "../../.opencode/tools/godot_shader_reader/source-info.ts"
import { readGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-reader.ts"
import { readGodot36Shader } from "../../.opencode/tools/godot_shader_reader/shader-reader.ts"
import { searchGodotShaders } from "../../.opencode/tools/godot_shader_reader/search.ts"
import { validateShaderRequest } from "../../.opencode/tools/godot_shader_reader/validation-tool.ts"
import { externalShaderMaterial, minimalShaderMaterial } from "./fixture-builder.ts"

async function setup(t: any) {
  const directory = await mkdtemp(path.join(tmpdir(), "shader-source-search-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test("hash is equal across binary/text/external copies and excludes serialization NUL", async (t) => {
  const directory = await setup(t), code = "shader_type spatial;\r\n// 中文  \r\n"
  const binary = minimalShaderMaterial(code)
  const read = readGodot36Shader(binary)
  assert.equal(read.shader.code, code)
  assert.equal(read.shader.code.includes("\0"), false)
  assert.equal(read.shader.hash, shaderHash(code))
  await writeFile(path.join(directory, "embedded.material"), binary)
  await writeFile(path.join(directory, "source.shader"), code)
  await writeFile(path.join(directory, "text.tres"), '[gd_resource type="Shader" format=2]\n[resource]\ncode = ' + JSON.stringify(code))
  await writeFile(path.join(directory, "external.material"), externalShaderMaterial("source.shader"))
  for (const file of ["embedded.material", "source.shader", "text.tres", "external.material"]) {
    assert.equal((await readGodotShaderFile(path.join(directory, file))).shader.hash, read.shader.hash)
  }
  assert.notEqual(shaderHash(code), shaderHash(code.replaceAll("\r\n", "\n")))
})

test("metadata hides source and indexes declarations outside comments; ranges stay exact", async (t) => {
  const directory = await setup(t), target = path.join(directory, "source.shader")
  const code = "shader_type spatial;\r\n// uniform float fake;\r\nuniform float gain : hint_range(0, 1) = 1.0;\r\n/* void fake() {} */\r\nfloat helper(\r\nfloat x) { return x; }\r\nvoid fragment() { ALBEDO = vec3(gain); }\r\n"
  await writeFile(target, code)
  const read = await readGodotShaderFile(target)
  const metadata = sourceView(read, { metadata_only: true })
  assert.equal("code" in metadata.shader, false)
  assert.equal(metadata.shader.hash, shaderHash(code))
  assert.equal(metadata.shader.line_count, 7)
  assert.deepEqual((metadata.shader as any).functions.map((f: any) => f.name), ["helper", "fragment"])
  assert.equal((metadata.shader as any).uniforms.length, 1)
  assert.equal((metadata.shader as any).uniforms[0].line, 3)
  const partial = sourceView(read, { start_line: 5, end_line: 6 })
  assert.equal((partial.shader as any).code, "float helper(\r\nfloat x) { return x; }\r\n")
  assert.equal(partial.shader.hash, metadata.shader.hash)
  for (const options of [{ start_line: 0 }, { end_line: 8 }, { start_line: 4, end_line: 2 }, { metadata_only: true, start_line: 1 }]) {
    assert.throws(() => sourceView(read, options), /Line range|metadata_only/)
  }
})

test("unified diff independently applies with git across separated edits, CRLF and EOF", async (t) => {
  const directory = await setup(t), target = path.join(directory, "sample.shader")
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("")
  for (const [before, after] of [["", "new\n"], ["old", ""], ["x\r\ny\r\n", "x\r\nz\r\n"], ["a\n", "a"],
    [lines, lines.replace("line 1\n", "replacement\n").replace("line 28\n", "extra\nline 28\n")], ["a\nb\na\n", "b\na\nb\n"]]) {
    await writeFile(target, before)
    const diff = unifiedDiff(before, after, "sample.shader")
    execFileSync("git", ["apply", "--no-index", "--unsafe-paths", "-p0", "-"], { cwd: directory, input: diff })
    assert.equal(await readFile(target, "utf8"), after)
  }
  assert.equal(unifiedDiff("unchanged", "unchanged", "sample.shader"), "")
})

test("search returns grouped hashes, literal or regex lines, pagination and corrupt-file errors", async (t) => {
  const directory = await setup(t), code = "shader_type spatial;\n// fresnel[0]\n// fresnel[1]\n"
  for (const name of ["a", "b"]) await writeFile(path.join(directory, `${name}.material`), minimalShaderMaterial(code))
  await writeFile(path.join(directory, "broken.material"), "corrupt")
  await mkdir(path.join(directory, ".godot"))
  await writeFile(path.join(directory, ".godot/skip.shader"), code)
  const result = await searchGodotShaders("fresnel", directory, { max_matches: 2, offset: 1 })
  assert.equal(result.scanned_files, 3)
  assert.equal(result.total_matches, 4)
  assert.equal(result.matches.length, 2)
  assert.equal(result.matches[0].line, 3)
  assert.equal(result.matches[0].shader_hash, result.matches[1].shader_hash)
  assert.equal(result.next_offset, 3)
  assert.equal(result.errors.length, 1)
  assert.equal((await searchGodotShaders("fresnel[0]", directory)).total_matches, 2)
  assert.equal((await searchGodotShaders("fresnel\\[[01]\\]", directory, { regex: true })).total_matches, 4)
  await assert.rejects(() => searchGodotShaders("[", directory, { regex: true }), /regular expression/)
})

test("validator selection never silently validates 3.5 or 4.x with the 3.6 compiler", async () => {
  const request = { shader_code: "shader_type spatial;" }
  assert.equal((await validateShaderRequest({ ...request, godot_version: "3.6", renderer: "gles3" }, ".")).valid, true)
  for (const options of [{ godot_version: "3.5" }, { godot_version: "4.3" }, { renderer: "gles2" }]) {
    await assert.rejects(() => validateShaderRequest({ ...request, ...options }, "."), /Only the official/)
  }
})
