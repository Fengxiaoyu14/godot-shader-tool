import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { readGodotShaderFile, type ShaderFileReadOptions } from "./file-reader.ts"
import { GodotReaderError, toPublicError } from "./errors.ts"
import { sourceLines } from "./source-info.ts"

export interface ShaderSearchOptions extends ShaderFileReadOptions {
  regex?: boolean
  max_matches?: number
  offset?: number
}

export async function searchGodotShaders(pattern: string, projectRoot: string, options: ShaderSearchOptions = {}) {
  const limit = options.max_matches ?? 200, offset = options.offset ?? 0
  if (!pattern || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new GodotReaderError("INVALID_SEARCH_ARGUMENTS", "Require a non-empty pattern, max_matches 1..10000, and non-negative offset")
  }
  let expression: RegExp | undefined
  try { if (options.regex) expression = new RegExp(pattern) }
  catch (cause) { throw new GodotReaderError("INVALID_SEARCH_ARGUMENTS", "Invalid JavaScript regular expression", { cause }) }
  const root = await realpath(projectRoot)
  if (!(await stat(root)).isDirectory()) throw new GodotReaderError("INVALID_SEARCH_ARGUMENTS", "project_root must be a directory")
  const matches: Array<{ path: string; shader_path: string; shader_hash: string; line: number; text: string }> = []
  const errors: Array<{ path: string; error: ReturnType<typeof toPublicError> }> = []
  let scanned = 0, readable = 0, totalMatches = 0
  async function visit(directory: string) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { errors.push({ path: directory, error: toPublicError(error) }); return }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (![".git", ".godot", ".import", "node_modules"].includes(entry.name)) await visit(target)
      } else if (entry.isFile() && [".material", ".res", ".tres", ".shader", ".gdshader"].includes(path.extname(entry.name).toLowerCase())) {
        scanned++
        try {
          const result = await readGodotShaderFile(target, { ...options, projectRoot: root })
          readable++
          const lines = sourceLines(result.shader.code)
          for (const [index, line] of lines.entries()) {
            const text = line.replace(/\r?\n$/, "")
            if (expression ? expression.test(text) : text.includes(pattern)) {
              if (totalMatches >= offset && matches.length < limit) matches.push({ path: result.path, shader_path: result.shader.path, shader_hash: result.shader.hash, line: index + 1, text })
              totalMatches++
            }
          }
        } catch (error) { errors.push({ path: target, error: toPublicError(error) }) }
      }
    }
  }
  await visit(root)
  return { success: errors.length === 0, project_root: root, scanned_files: scanned, readable_files: readable,
    total_matches: totalMatches, offset, matches, truncated: offset + matches.length < totalMatches,
    next_offset: offset + matches.length < totalMatches ? offset + matches.length : null, errors }
}
