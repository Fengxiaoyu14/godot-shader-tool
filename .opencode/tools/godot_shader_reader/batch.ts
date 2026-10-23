import { readFile } from "node:fs/promises"
import path from "node:path"
import { readGodotShaderFile } from "./file-reader.ts"
import { patchGodotShaderFile, type ShaderFileWriteOptions } from "./file-writer.ts"
import { parsePatchOps, type ShaderPatchOp } from "./patch.ts"
import { GodotReaderError, toPublicError, type PublicError } from "./errors.ts"

interface PlanEntry {
  path: string
  ops: ShaderPatchOp[]
  expected_resource_hash?: string
  expected_hash?: string
  project_root?: string
  shader_path?: string
  godot_version?: string
  renderer?: string
}

/** Snapshot the plan once. Entry paths are relative to the plan, independent of cwd. */
export async function applyShaderPlan(planPath: string, options: ShaderFileWriteOptions = {}) {
  planPath = path.resolve(planPath)
  let json: unknown
  try { json = JSON.parse(await readFile(planPath, "utf8")) }
  catch (cause) { throw new GodotReaderError("INVALID_PLAN", "Could not read a JSON plan", { cause }) }
  if (!Array.isArray(json) || json.length === 0) throw new GodotReaderError("INVALID_PLAN", "Plan must be a non-empty JSON array")
  const base = path.dirname(planPath)
  type Prepared = { index: number; path?: string; entry?: PlanEntry; target?: string; hash?: string; resourceHash?: string; options?: ShaderFileWriteOptions; error?: PublicError }
  const prepared: Prepared[] = []
  // Resolve every actual target BEFORE any mutation, including shared dependencies.
  for (const [index, raw] of json.entries()) {
    const item: Prepared = { index, ...(typeof raw?.path === "string" ? { path: path.resolve(base, raw.path) } : {}) }
    prepared.push(item)
    try {
      const entry = parseEntry(raw)
      item.entry = entry
      item.path = path.resolve(base, entry.path)
      item.options = {
        ...options,
        ...(entry.godot_version === undefined ? {} : { godotVersion: entry.godot_version }),
        ...(entry.renderer === undefined ? {} : { renderer: entry.renderer }),
        ...(entry.project_root === undefined ? {} : { projectRoot: path.resolve(base, entry.project_root) }),
        ...(entry.shader_path === undefined ? {} : { shaderPath: path.resolve(base, entry.shader_path) }),
      }
      const read = await readGodotShaderFile(item.path, item.options)
      item.target = entry.ops.some(op => "setParam" in op) ? read.path : read.shader.path
      item.resourceHash = read.resource_hash
      item.hash = read.shader.hash
    } catch (error) { item.error = toPublicError(error) }
  }
  const targets = new Map<string, Prepared[]>()
  for (const item of prepared) if (item.target) {
    const peers = targets.get(item.target) ?? []
    peers.push(item)
    targets.set(item.target, peers)
  }
  // Refuse all colliding entries. Do not let plan order choose which edit wins.
  for (const [target, peers] of targets) if (peers.length > 1) for (const item of peers) {
    item.error = toPublicError(new GodotReaderError("DUPLICATE_WRITE_TARGET", "Multiple plan entries resolve to the same Shader; keep one entry for this target", {
      details: { written_path: target, entry_indexes: peers.map((peer) => peer.index) },
    }))
  }
  const results: Array<Record<string, unknown>> = []
  for (const item of prepared) {
    const identity = { index: item.index, path: item.path, ...(item.target ? { written_path: item.target } : {}) }
    if (item.error) { results.push({ ...identity, success: false, status: "rejected", original_preserved: true, error: item.error }); continue }
    try {
      const result = await patchGodotShaderFile(item.path!, item.entry!.ops, {
        ...item.options,
        expectedResourceHash: item.entry!.expected_resource_hash ?? item.resourceHash,
        expectedHash: item.entry!.expected_hash ?? item.hash,
        expectedTarget: item.target,
      })
      results.push({ ...identity, success: true, status: options.dryRun ? "dry_run" : "success", ...result })
    } catch (error) {
      const failure = toPublicError(error)
      // Never claim rollback on a concurrent edit or an uncertain OS replacement failure.
      const preserved = !["UNEXPECTED_RESOURCE_CHANGE", "ATOMIC_REPLACE_FAILED", "INTERNAL_ERROR"].includes(failure.code)
      results.push({ ...identity, success: false, status: preserved ? "failed_original_preserved" : "failed_check_required", original_preserved: preserved, error: failure })
    }
  }
  const succeeded = results.filter((result) => result.success).length
  return { success: succeeded === results.length, plan_path: planPath, dry_run: options.dryRun ?? false,
    summary: { total: results.length, succeeded, failed: results.length - succeeded }, results }
}

function parseEntry(value: unknown): PlanEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GodotReaderError("INVALID_PLAN", "Plan entry must be an object")
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).some((key) => !["path", "ops", "expected_resource_hash", "expected_hash", "project_root", "shader_path", "godot_version", "renderer"].includes(key)) ||
      typeof entry.path !== "string" || entry.path.trim().length === 0 ||
      ["project_root", "shader_path", "godot_version", "renderer"].some((key) => entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key].trim())) ||
      (entry.expected_resource_hash !== undefined && (typeof entry.expected_resource_hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.expected_resource_hash))) ||
      (entry.expected_hash !== undefined && (typeof entry.expected_hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.expected_hash)))) {
    throw new GodotReaderError("INVALID_PLAN", "Invalid plan fields: require path, ops, optional expected_hash/project_root/shader_path")
  }
  return { ...entry, ops: parsePatchOps(entry.ops) } as unknown as PlanEntry
}
