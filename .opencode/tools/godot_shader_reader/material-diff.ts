import { isDeepStrictEqual } from "node:util"
import { readGodotShaderFile, type ShaderFileReadOptions } from "./file-reader.ts"
import { unifiedDiff } from "./source-info.ts"

export async function diffGodotMaterials(beforePath: string, afterPath: string, beforeOptions: ShaderFileReadOptions = {}, afterOptions: ShaderFileReadOptions = {}) {
  const [before, after] = await Promise.all([
    readGodotShaderFile(beforePath, { ...beforeOptions, params: true }),
    readGodotShaderFile(afterPath, { ...afterOptions, params: true }),
  ])
  const rows: Array<Record<string, unknown>> = []
  // Internal paths often include filenames. Pair root with root and subresources by local path.
  const flatten = (result: typeof before) => new Map((result.params?.materials ?? []).flatMap((m, i, all) => m.properties.map(p => {
    const key = `${i === all.length - 1 ? "root" : m.path}/${p.name}`
    const value = p.external_resource ? { type: p.type, type_id: p.type_id, texture: { type: p.external_resource.type, path: p.external_resource.path } } : { type: p.type, type_id: p.type_id, value: p.value }
    return [key, value] as const
  })))
  const a = flatten(before), b = flatten(after)
  for (const key of new Set([...a.keys(), ...b.keys()])) if (!isDeepStrictEqual(a.get(key), b.get(key))) {
    rows.push({ parameter: key, change: !a.has(key) ? "added" : !b.has(key) ? "removed" : "changed", before: a.get(key) ?? null, after: b.get(key) ?? null })
  }
  const code_diff = unifiedDiff(before.shader.code, after.shader.code, `${before.path} -> ${after.path}`)
  const cell = (value: unknown) => JSON.stringify(value).replace(/\|/g, "\\|").replace(/\n/g, " ")
  const difference_table = ["| 参数 | 变化 | 修改前 | 修改后 |", "| --- | --- | --- | --- |", ...rows.map(r => `| ${cell(r.parameter)} | ${r.change} | ${cell(r.before)} | ${cell(r.after)} |`)].join("\n")
  return { difference_table, before_path: before.path, after_path: after.path, equal: !code_diff && !rows.length, shader: { changed: !!code_diff, before_hash: before.shader.hash, after_hash: after.shader.hash, diff: code_diff }, parameter_diff: rows }
}
