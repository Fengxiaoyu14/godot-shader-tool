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
import { minimalShaderMaterial } from "./fixture-builder.ts"

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
    "const stringSchema = () => ({ optional() { return this }, describe() { return this } })\n" +
      "export const tool = (definition) => definition\n" +
      "tool.schema = { string: stringSchema }\n",
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
})
