import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { applyShaderPatch, parsePatchOps } from "../../.opencode/tools/godot_shader_reader/patch.ts"
import { patchGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-writer.ts"
import { applyShaderPlan } from "../../.opencode/tools/godot_shader_reader/batch.ts"
import { readGodotShaderFile } from "../../.opencode/tools/godot_shader_reader/file-reader.ts"
import { shaderHash } from "../../.opencode/tools/godot_shader_reader/source-info.ts"
import { GodotReaderError } from "../../.opencode/tools/godot_shader_reader/errors.ts"
import { validateGodot36Shader } from "../../.opencode/tools/godot_shader_reader/validator.ts"
import { buildRscc, externalShaderMaterial, minimalShaderMaterial } from "./fixture-builder.ts"

const source = "shader_type spatial;\r\n// 中文  \r\nvoid fragment() {\r\n  ALBEDO = vec3(0.5);  \r\n}\r\n"
const ops = [{ find: "vec3(0.5)", replace: "vec3(0.8)", expect: 1 }]
const valid = async () => ({ valid: true as const, godot_version: "3.6" as const, renderer: "gles3" as const, shader_type: "spatial" as const })
const codeIs = (code: string) => (error: unknown) => error instanceof GodotReaderError && error.code === code

async function setup(t: any) {
  const directory = await mkdtemp(path.join(tmpdir(), "shader-patch-batch-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test("literal patch counts non-overlapping matches and preserves replacement metacharacters", () => {
  assert.equal(applyShaderPatch("aaa", [{ find: "aa", replace: "$&$1\\", expect: 1 }]), "$&$1\\a")
  assert.equal(applyShaderPatch("x x", [{ find: "x", replace: "y", expect: 2 }, { find: "y", replace: "z", expect: 2 }]), "z z")
  assert.throws(() => applyShaderPatch("x x", [{ find: "x", replace: "y", expect: 1 }]), codeIs("PATCH_EXPECT_MISMATCH"))
})

test("strict op validation rejects unknown fields and unguarded line deletions", () => {
  for (const value of [[], [{ find: "", replace: "x", expect: 1 }], [{ find: "x", replace: "y" }], [{ find: "x", replace: "y", expect: 0 }],
    [{ find: "x", replace: "y", expect: 1, typo: true }], [{ delete_lines: [1, 2] }], [{ delete_lines: [1, 2], expected_text: "x", expect: 2 }]]) {
    assert.throws(() => parsePatchOps(value), codeIs("INVALID_PATCH"))
  }
})

test("line deletion checks current inclusive range and exact CRLF content", () => {
  const code = "a\r\nb\r\nc"
  assert.equal(applyShaderPatch(code, [{ delete_lines: [2, 2], expected_text: "b\r\n", expect: 1 }]), "a\r\nc")
  assert.throws(() => applyShaderPatch(code, [{ delete_lines: [2, 2], expected_text: "b\n", expect: 1 }]), codeIs("PATCH_EXPECT_MISMATCH"))
  assert.throws(() => applyShaderPatch(code, [{ find: "a", replace: "a\r\nx", expect: 1 }, { delete_lines: [2, 2], expected_text: "b\r\n", expect: 1 }]), codeIs("PATCH_EXPECT_MISMATCH"))
})

test("a later failed op leaves the material byte-identical and creates no temp", async (t) => {
  const directory = await setup(t), target = path.join(directory, "x.material")
  const bytes = minimalShaderMaterial(source)
  await writeFile(target, bytes)
  await assert.rejects(() => patchGodotShaderFile(target, [...ops, { find: "absent", replace: "", expect: 1 }]), codeIs("PATCH_EXPECT_MISMATCH"))
  assert.deepEqual(await readFile(target), bytes)
  assert.deepEqual(await readdir(directory), ["x.material"])
})

test("patch validates RSCC roundtrip, hashes, diff and exact unaffected whitespace", async (t) => {
  const directory = await setup(t), target = path.join(directory, "x.material")
  await writeFile(target, buildRscc(minimalShaderMaterial(source, false), 128))
  const codecs = { zstdDecoder: (b: Uint8Array) => zstdDecompressSync(b), zstdEncoder: (b: Uint8Array) => zstdCompressSync(b) }
  const result = await patchGodotShaderFile(target, ops, { ...codecs, expectedHash: shaderHash(source) })
  assert.equal(result.before.shader_hash, shaderHash(source))
  assert.equal(result.after.shader_hash, shaderHash(source.replace("0.5", "0.8")))
  assert.match(result.expected_diff, /-  ALBEDO = vec3\(0\.5\);  \r\n\+  ALBEDO = vec3\(0\.8\);  \r\n/)
  assert.equal((await readGodotShaderFile(target, codecs)).shader.code, source.replace("0.5", "0.8"))
  assert.equal(result.validation.post_write_shader, true)
})

test("dry-run executes official pre/post validation but retains original bytes", async (t) => {
  const directory = await setup(t), target = path.join(directory, "x.material")
  const bytes = minimalShaderMaterial(source)
  await writeFile(target, bytes)
  const result = await patchGodotShaderFile(target, ops, { dryRun: true })
  assert.equal(result.dry_run, true)
  assert.equal(result.validation.post_write_shader, true)
  assert.notEqual(result.expected_diff, "")
  assert.deepEqual(await readFile(target), bytes)
  assert.deepEqual(await readdir(directory), ["x.material"])
})

test("stale hash and unsupported validator profile fail closed", async (t) => {
  const directory = await setup(t), target = path.join(directory, "x.material")
  const bytes = minimalShaderMaterial(source)
  await writeFile(target, bytes)
  await assert.rejects(() => patchGodotShaderFile(target, ops, { expectedHash: "0".repeat(64) }), codeIs("SHADER_HASH_MISMATCH"))
  await assert.rejects(() => patchGodotShaderFile(target, ops, { godotVersion: "4.3" }), codeIs("UNSUPPORTED_VALIDATOR_PROFILE"))
  assert.deepEqual(await readFile(target), bytes)
})

test("patch pre/post validation failures both preserve original", async (t) => {
  const directory = await setup(t), target = path.join(directory, "x.material")
  const bytes = minimalShaderMaterial(source)
  await writeFile(target, bytes)
  await assert.rejects(() => patchGodotShaderFile(target, [{ find: "vec3(0.5)", replace: "missing_symbol", expect: 1 }]), codeIs("SHADER_VALIDATION_FAILED"))
  let calls = 0
  await assert.rejects(() => patchGodotShaderFile(target, ops, { shaderValidator: async () => {
    if (++calls === 1) return valid()
    return { valid: false, godot_version: "3.6", renderer: "gles3", error: { line: 1, message: "injected post failure" } }
  } }), codeIs("SHADER_VALIDATION_FAILED"))
  assert.equal(calls, 2)
  assert.deepEqual(await readFile(target), bytes)
  assert.deepEqual(await readdir(directory), ["x.material"])
})

test("concurrent source edit during patch validation is preserved instead of overwritten", async (t) => {
  const directory = await setup(t), target = path.join(directory, "x.shader")
  await writeFile(target, source)
  let calls = 0
  await assert.rejects(() => patchGodotShaderFile(target, ops, { shaderValidator: async () => {
    if (++calls === 1) await writeFile(target, source + "// concurrent\n")
    return valid()
  } }), codeIs("UNEXPECTED_RESOURCE_CHANGE"))
  assert.equal(await readFile(target, "utf8"), source + "// concurrent\n")
})

test("batch continues after invalid shader and invalid entry, resolves paths from plan", async (t) => {
  const directory = await setup(t)
  const original = minimalShaderMaterial(source)
  for (const name of ["a", "b", "c"]) await writeFile(path.join(directory, `${name}.material`), original)
  const plan = path.join(directory, "plan.json")
  await writeFile(plan, JSON.stringify([
    { path: "a.material", ops },
    { path: "b.material", ops: [{ find: "vec3(0.5)", replace: "missing_symbol", expect: 1 }] },
    { path: "c.material", ops, expected_hash: shaderHash(source) },
    { path: "missing.material", ops },
    { path: "a.material", opps: ops },
  ]))
  const result = await applyShaderPlan(plan)
  assert.deepEqual(result.summary, { total: 5, succeeded: 2, failed: 3 })
  assert.equal(result.results[1].status, "failed_original_preserved")
  assert.equal(result.results[3].status, "rejected")
  assert.deepEqual(await readFile(path.join(directory, "b.material")), original)
  assert.equal((await readGodotShaderFile(path.join(directory, "c.material"))).shader.code, source.replace("0.5", "0.8"))
})

test("batch rejects ALL duplicate external targets before writing either", async (t) => {
  const directory = await setup(t)
  await writeFile(path.join(directory, "project.godot"), "")
  await writeFile(path.join(directory, "shared.shader"), source)
  for (const name of ["a", "b"]) await writeFile(path.join(directory, `${name}.material`), externalShaderMaterial("res://shared.shader"))
  const plan = path.join(directory, "plan.json")
  await writeFile(plan, JSON.stringify(["a.material", "b.material"].map((path) => ({ path, ops }))))
  const result = await applyShaderPlan(plan)
  assert.equal(result.summary.failed, 2)
  for (const row of result.results) assert.equal((row.error as any).code, "DUPLICATE_WRITE_TARGET")
  assert.equal(await readFile(path.join(directory, "shared.shader"), "utf8"), source)
})

test("batch external override writes only the selected shared file", async (t) => {
  const directory = await setup(t)
  const original = externalShaderMaterial("res://missing.shader")
  await writeFile(path.join(directory, "a.material"), original)
  await writeFile(path.join(directory, "shared.shader"), source)
  const plan = path.join(directory, "plan.json")
  await writeFile(plan, JSON.stringify([{ path: "a.material", shader_path: "shared.shader", ops }]))
  assert.equal((await applyShaderPlan(plan)).summary.succeeded, 1)
  assert.deepEqual(await readFile(path.join(directory, "a.material")), original)
  assert.equal(await readFile(path.join(directory, "shared.shader"), "utf8"), source.replace("0.5", "0.8"))
})

test("batch freezes preflight hashes; later concurrent edit is not patched", async (t) => {
  const directory = await setup(t)
  for (const name of ["a", "b"]) await writeFile(path.join(directory, `${name}.shader`), source)
  const plan = path.join(directory, "plan.json")
  await writeFile(plan, JSON.stringify(["a.shader", "b.shader"].map((path) => ({ path, ops }))))
  let calls = 0
  const result = await applyShaderPlan(plan, { shaderValidator: async () => {
    if (++calls === 1) await writeFile(path.join(directory, "b.shader"), source + "// edited\n")
    return valid()
  } })
  assert.equal(result.summary.succeeded, 1)
  assert.equal((result.results[1].error as any).code, "SHADER_HASH_MISMATCH")
  assert.equal(await readFile(path.join(directory, "b.shader"), "utf8"), source + "// edited\n")
})

test("63 embedded copies run from one plan with independent official pre/post validation", async (t) => {
  const directory = await setup(t), plan = path.join(directory, "plan.json")
  const entries = []
  for (let i = 0; i < 63; i++) {
    const file = `${i}.material`
    await writeFile(path.join(directory, file), minimalShaderMaterial(source))
    entries.push({ path: file, ops, expected_hash: shaderHash(source) })
  }
  await writeFile(plan, JSON.stringify(entries))
  let calls = 0
  const result = await applyShaderPlan(plan, { shaderValidator: (code) => { calls++; return validateGodot36Shader(code) } })
  assert.deepEqual(result.summary, { total: 63, succeeded: 63, failed: 0 })
  assert.equal(calls, 126)
  for (const entry of entries) assert.equal((await readGodotShaderFile(path.join(directory, entry.path))).shader.hash, shaderHash(source.replace("0.5", "0.8")))
})
