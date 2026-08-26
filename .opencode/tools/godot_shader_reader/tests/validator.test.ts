import assert from "node:assert/strict"
import test from "node:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { GodotReaderError } from "../errors.ts"
import { bundledValidatorPath, validateGodot36Shader } from "../validator.ts"

const fixtureDirectory = fileURLToPath(new URL("../../../../validator/tests/shaders/", import.meta.url))

test("bundled validator uses official Godot 3.6 GLES3 semantics", async (t) => {
  const cases = [
    ["valid-spatial.gdshader", true, "spatial"],
    ["instance-custom.gdshader", true, "spatial"],
    ["render-modes.gdshader", true, "spatial"],
    ["gles3-uint-uvec.gdshader", true, "spatial"],
    ["gles3-array.gdshader", true, "spatial"],
    ["gles3-switch.gdshader", true, "spatial"],
    ["valid-canvas-item.gdshader", true, "canvas_item"],
    ["valid-particles.gdshader", true, "particles"],
    ["syntax-error.gdshader", false, "spatial"],
    ["unknown-identifier.gdshader", false, "spatial"],
    ["invalid-render-mode.gdshader", false, "spatial"],
  ] as const

  for (const [fixture, expectedValid, expectedType] of cases) {
    await t.test(fixture, async () => {
      const result = await validateGodot36Shader(await readFile(path.join(fixtureDirectory, fixture), "utf8"))
      assert.equal(result.valid, expectedValid)
      assert.equal(result.godot_version, "3.6")
      assert.equal(result.renderer, "gles3")
      assert.equal(result.shader_type, expectedType)
      if (!result.valid) {
        assert.ok(result.error.line > 0)
        assert.ok(result.error.message.length > 0)
      }
    })
  }
})

test("bundled executable path is module-relative and architecture-specific", () => {
  assert.match(bundledValidatorPath("linux", "x64"), /bin[\\/]linux-x64[\\/]godot-shader-validator$/)
  assert.match(bundledValidatorPath("win32", "x64"), /bin[\\/]windows-x64[\\/]godot-shader-validator\.exe$/)
  assert.throws(
    () => bundledValidatorPath("darwin", "x64"),
    (error: unknown) => error instanceof GodotReaderError && error.code === "SHADER_VALIDATOR_UNAVAILABLE",
  )
  assert.throws(
    () => bundledValidatorPath("linux", "arm64"),
    (error: unknown) => error instanceof GodotReaderError && error.code === "SHADER_VALIDATOR_UNAVAILABLE",
  )
})

test("missing validator fails closed", async () => {
  await assert.rejects(
    () => validateGodot36Shader("shader_type spatial;\n", {
      executablePath: path.join(tmpdir(), "godot-validator-does-not-exist"),
    }),
    (error: unknown) => error instanceof GodotReaderError && error.code === "SHADER_VALIDATOR_UNAVAILABLE",
  )
})

test("invalid validator JSON fails closed", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-validator-json-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, "invalid-json.sh")
  await writeExecutable(executable, "#!/bin/sh\nprintf 'not-json\\n'\n")

  await assert.rejects(
    () => validateGodot36Shader("shader_type spatial;\n", { executablePath: executable }),
    (error: unknown) => error instanceof GodotReaderError && error.code === "INVALID_VALIDATOR_RESPONSE",
  )
})

test("unexpected validator stderr fails closed", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-validator-stderr-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, "stderr.sh")
  await writeExecutable(
    executable,
    "#!/bin/sh\nprintf '%s\\n' '{\"valid\":true,\"godot_version\":\"3.6\",\"renderer\":\"gles3\",\"shader_type\":\"spatial\"}'\nprintf 'unexpected diagnostic\\n' >&2\n",
  )

  await assert.rejects(
    () => validateGodot36Shader("shader_type spatial;\n", { executablePath: executable }),
    (error: unknown) => error instanceof GodotReaderError && error.code === "INVALID_VALIDATOR_RESPONSE",
  )
})

test("validator timeout fails closed", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-validator-timeout-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, "timeout.sh")
  await writeExecutable(executable, "#!/bin/sh\nexec sleep 2\n")

  await assert.rejects(
    () => validateGodot36Shader("shader_type spatial;\n", { executablePath: executable, timeoutMs: 25 }),
    (error: unknown) => error instanceof GodotReaderError && error.code === "SHADER_VALIDATOR_TIMEOUT",
  )
})

test("validator internal exit is not mistaken for a shader error", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "godot-validator-internal-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, "internal.sh")
  await writeExecutable(
    executable,
    "#!/bin/sh\nprintf '%s\\n' '{\"valid\":false,\"internal_error\":{\"code\":\"TEST\",\"message\":\"injected failure\"}}'\nexit 2\n",
  )

  await assert.rejects(
    () => validateGodot36Shader("shader_type spatial;\n", { executablePath: executable }),
    (error: unknown) => error instanceof GodotReaderError &&
      error.code === "SHADER_VALIDATOR_FAILED" &&
      error.message === "injected failure",
  )
})

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents)
  await chmod(filePath, 0o700)
}
