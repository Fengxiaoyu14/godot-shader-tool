import assert from "node:assert/strict"
import test from "node:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  findForbiddenTestContent,
  RELEASE_PLATFORMS,
  stageReleasePackage,
} from "../../scripts/release-package.mjs"
import { externalShaderMaterial, minimalShaderMaterial } from "./fixture-builder.ts"

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))
const releasePlatform = process.arch !== "x64"
  ? undefined
  : process.platform === "linux"
    ? "linux-x64"
    : process.platform === "win32"
      ? "windows-x64"
      : undefined

test("every staged release package excludes tests and non-target binaries", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-release-layout-"))
  t.after(() => rm(directory, { recursive: true, force: true }))

  for (const platform of Object.keys(RELEASE_PLATFORMS)) {
    const staged = await stageReleasePackage(repositoryRoot, path.join(directory, platform), platform)
    assert.deepEqual(await findForbiddenTestContent(staged.root), [], platform)
    assert.deepEqual(await readdir(path.join(staged.tools, "bin")), [platform], platform)
  }
})

test("host release package passes validate/write/read smoke", {
  skip: releasePlatform === undefined ? "No release package is available for this host" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-opencode-e2e-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const packageRoot = path.join(directory, "package")
  const staged = await stageReleasePackage(repositoryRoot, packageRoot, releasePlatform!)
  assert.deepEqual(await findForbiddenTestContent(packageRoot), [])
  if (process.platform !== "win32") {
    await chmod(staged.validator, 0o700)
  }

  const pluginDirectory = path.join(packageRoot, "node_modules/@opencode-ai/plugin")
  await mkdir(pluginDirectory, { recursive: true })
  await writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({
    name: "@opencode-ai/plugin",
    version: "0.0.0-test",
    type: "module",
    exports: "./index.js",
  }))
  await writeFile(
    path.join(pluginDirectory, "index.js"),
    "const stringSchema = () => ({ optional() { return this }, describe() { return this }, int() { return this }, positive() { return this }, nonnegative() { return this }, strict() { return this } })\n" +
      "export const tool = (definition) => definition\n" +
      "tool.schema = Object.fromEntries(['string', 'number', 'boolean', 'array', 'union', 'object', 'tuple', 'literal', 'unknown'].map(k => [k, stringSchema]))\n",
  )

  const validateTool = (await import(pathToFileURL(
    path.join(staged.tools, "godot-shader-validate.ts"),
  ).href)).default
  const writeTool = (await import(pathToFileURL(
    path.join(staged.tools, "godot-shader-write.ts"),
  ).href)).default
  const readTool = (await import(pathToFileURL(
    path.join(staged.tools, "godot-shader-read.ts"),
  ).href)).default
  const context = { worktree: directory }
  const validSource = "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(0.4); }\n"
  const replacement = "shader_type spatial;\r\n// OpenCode 端到端\r\nvoid fragment() { ALBEDO = vec3(0.8); }\r\n"
  const materialPath = path.join(directory, "test.material")
  await writeFile(materialPath, minimalShaderMaterial(validSource))

  const directValidation = JSON.parse(await validateTool.execute({ shader_code: validSource }, context))
  assert.equal(directValidation.valid, true)
  const pathValidation = JSON.parse(await validateTool.execute({ path: "test.material" }, context))
  assert.equal(pathValidation.valid, true)

  const writeResult = JSON.parse(await writeTool.execute({
    path: "test.material",
    shader_code: replacement,
  }, context))
  assert.equal(writeResult.success, true)
  assert.deepEqual(writeResult.validation, {
    pre_write_shader: true,
    resource_read_back: true,
    shader_code_match: true,
    semantic_diff: true,
    post_write_shader: true,
  })

  const readResult = JSON.parse(await readTool.execute({ path: "test.material" }, context))
  assert.equal(readResult.success, true)
  assert.equal(readResult.shader.code, replacement)

  const bytesBeforeInvalidWrite = await readFile(materialPath)
  const invalidResult = JSON.parse(await writeTool.execute({
    path: "test.material",
    shader_code: "shader_type spatial;\nvoid fragment() { ALBEDO = missing_value; }\n",
  }, context))
  assert.equal(invalidResult.success, false)
  assert.equal(invalidResult.error.code, "SHADER_VALIDATION_FAILED")
  assert.equal(invalidResult.original_preserved, true)
  assert.deepEqual(await readFile(materialPath), bytesBeforeInvalidWrite)

  // Exercise the installed wrappers and relative option paths, not only the library API.
  const externalPath = path.join(directory, "external.material")
  const shaderPath = path.join(directory, "renamed.tres")
  await writeFile(externalPath, externalShaderMaterial("res://renamed.tres"))
  await writeFile(shaderPath, '[gd_resource type="Shader" format=2]\n[resource]\ncode = ' + JSON.stringify(validSource))
  const missingRoot = JSON.parse(await readTool.execute({ path: externalPath }, context))
  assert.equal(missingRoot.error.code, "PROJECT_ROOT_NOT_FOUND")
  for (const options of [{ project_root: "." }, { shader_path: "renamed.tres" }]) {
    const externalRead = JSON.parse(await readTool.execute({ path: "external.material", ...options }, context))
    assert.equal(externalRead.success, true)
    assert.equal(externalRead.shader.source, "external")
    assert.equal(externalRead.shader.code, validSource)
    const externalValidation = JSON.parse(await validateTool.execute({ path: "external.material", ...options }, context))
    assert.equal(externalValidation.valid, true)
  }
  const originalExternal = await readFile(externalPath)
  const originalShader = await readFile(shaderPath)
  const externalWrite = JSON.parse(await writeTool.execute({ path: externalPath, shader_code: replacement, shader_path: "renamed.tres" }, context))
  assert.equal(externalWrite.success, true)
  assert.equal(externalWrite.shared_shader, true)
  assert.equal(externalWrite.written_path, shaderPath.split(path.sep).join("/"))
  assert.deepEqual(await readFile(externalPath), originalExternal)
  assert.notDeepEqual(await readFile(shaderPath), originalShader)
  const afterExternal = JSON.parse(await readTool.execute({ path: externalPath, shader_path: shaderPath }, context))
  assert.equal(afterExternal.shader.code, replacement)

  const patchTool = (await import(pathToFileURL(path.join(staged.tools, "godot-shader-write-patch.ts")).href)).default
  const diffTool = (await import(pathToFileURL(path.join(staged.tools, "godot-shader-diff.ts")).href)).default
  const codec = await import(pathToFileURL(path.join(staged.tools, "godot_shader_reader/codec.ts")).href)
  const material = codec.parseResource(await readFile(materialPath))
  material.resource.parsedInternalResources.at(-1).properties.push({ name: "shader_param/TexSize", offset: 0, value: { type: "real", type_id: 4, value: 0.5 } })
  const paramPath = path.join(directory, "params.material")
  await writeFile(paramPath, codec.serializeResource(material))
  const paramRead = JSON.parse(await readTool.execute({ path: paramPath }, context))
  assert.equal(paramRead.params.materials[0].properties[0].value, 0.5)
  const paramPatch = JSON.parse(await patchTool.execute({ path: paramPath, expected_resource_hash: paramRead.resource_hash,
    ops: [{ setParam: { name: "TexSize", value: 1 }, expect: 1 }] }, context))
  assert.equal(paramPatch.success, true)
  const materialDiff = JSON.parse(await diffTool.execute({ before: materialPath, after: paramPath }, context))
  assert.equal(materialDiff.success, true)
  assert.equal(materialDiff.parameter_diff[0].change, "added")
  assert.match(materialDiff.difference_table, /TexSize/)
  const planTool = (await import(pathToFileURL(path.join(staged.tools, "godot-shader-write-plan.ts")).href)).default
  const searchTool = (await import(pathToFileURL(path.join(staged.tools, "godot-shader-search.ts")).href)).default
  const metadata = JSON.parse(await readTool.execute({ path: "test.material", metadata_only: true }, context))
  assert.equal(metadata.success, true)
  assert.equal("code" in metadata.shader, false)
  assert.match(metadata.shader.hash, /^[a-f0-9]{64}$/)
  const partial = JSON.parse(await readTool.execute({ path: "test.material", start_line: 1, end_line: 1 }, context))
  assert.equal(partial.shader.code, "shader_type spatial;\r\n")
  assert.equal(partial.shader.hash, metadata.shader.hash)
  const patchResult = JSON.parse(await patchTool.execute({
    path: "test.material", expected_hash: metadata.shader.hash,
    ops: [{ find: "vec3(0.8)", replace: "vec3(0.9)", expect: 1 }],
  }, context))
  assert.equal(patchResult.success, true)
  assert.match(patchResult.expected_diff, /vec3\(0\.9\)/)
  await writeFile(path.join(directory, "plan.json"), JSON.stringify([
    { path: "test.material", expected_hash: patchResult.after.shader_hash, ops: [{ find: "vec3(0.9)", replace: "vec3(0.7)", expect: 1 }] },
  ]))
  const beforeDryRun = await readFile(materialPath)
  const dry = JSON.parse(await planTool.execute({ plan_path: "plan.json", dry_run: true }, context))
  assert.equal(dry.summary.succeeded, 1)
  assert.equal(dry.results[0].status, "dry_run")
  assert.deepEqual(await readFile(materialPath), beforeDryRun)
  const applied = JSON.parse(await planTool.execute({ plan_path: "plan.json" }, context))
  assert.equal(applied.summary.succeeded, 1)
  const searched = JSON.parse(await searchTool.execute({ pattern: "vec3(0.7)", project_root: directory }, context))
  assert.equal(searched.matches.length, 1)
  assert.equal(searched.matches[0].shader_hash, applied.results[0].after.shader_hash)
  const unsupported = JSON.parse(await planTool.execute({ plan_path: "plan.json", godot_version: "4.3" }, context))
  assert.equal(unsupported.results[0].error.code, "UNSUPPORTED_VALIDATOR_PROFILE")

  if (process.env.GODOT4_BIN) {
    // Exercise installed OpenCode wrappers and packaged GDScript, not source imports.
    const godot4 = path.join(directory, "godot4.tres")
    const source4 = "shader_type spatial;\nuniform vec4 tint : source_color;\nvoid fragment(){ ALBEDO=tint.rgb; }"
    await writeFile(godot4, '[gd_resource type="Shader" format=3]\n[resource]\ncode=' + JSON.stringify(source4))
    const valid4 = JSON.parse(await validateTool.execute({ path: godot4 }, context))
    assert.equal(valid4.valid, true)
    assert.equal(valid4.renderer, "dummy")
    const written4 = JSON.parse(await writeTool.execute({ path: godot4, shader_code: source4 + "\n// replacement" }, context))
    assert.equal(written4.success, true)
    const read4 = JSON.parse(await readTool.execute({ path: godot4 }, context))
    assert.equal(read4.shader.code, source4 + "\n// replacement")

    const material4 = path.join(directory, "material4.tres"), baseline4 = path.join(directory, "baseline4.tres")
    const fixture4 = await readFile(new URL("./fixtures/godot4/embedded.tres", import.meta.url))
    await writeFile(material4, fixture4)
    await writeFile(baseline4, fixture4)
    const params4 = JSON.parse(await readTool.execute({ path: material4 }, context))
    assert.equal(params4.params.materials[0].properties[0].name, "tint")
    const patch4 = JSON.parse(await patchTool.execute({ path: material4, expected_resource_hash: params4.resource_hash, ops: [{ setParam: { name: "tint", value: [1, 0, 0, 1] }, expect: 1 }] }, context))
    assert.equal(patch4.success, true)
    const diff4 = JSON.parse(await diffTool.execute({ before: baseline4, after: material4 }, context))
    assert.equal(diff4.parameter_diff[0].parameter, "root/tint")
    await writeFile(path.join(directory, "plan4.json"), JSON.stringify([
      { path: "godot4.tres", ops: [{ find: "tint.rgb", replace: "vec3(0.5)", expect: 1 }], godot_version: "4.x", renderer: "dummy" },
      { path: "material4.tres", ops: [{ setParam: { name: "tint", value: [0, 1, 0, 1] }, expect: 1 }] },
    ]))
    const plan4 = JSON.parse(await planTool.execute({ plan_path: "plan4.json" }, context))
    assert.equal(plan4.summary.succeeded, 2)
    const search4 = JSON.parse(await searchTool.execute({ pattern: "tint.rgb", project_root: directory }, context))
    assert.ok(search4.matches.some(m => m.path.endsWith("material4.tres")))
  }

})
