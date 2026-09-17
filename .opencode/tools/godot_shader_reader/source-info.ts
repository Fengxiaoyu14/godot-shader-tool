import { createHash } from "node:crypto"
import { GodotReaderError } from "./errors.ts"
import type { ShaderFileReadResult } from "./file-reader.ts"

/** Hash decoded UTF-8 source, with no whitespace or newline normalization. */
export function shaderHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex")
}

/** Physical lines, retaining their exact terminators; no phantom line after final LF. */
export function sourceLines(code: string): string[] {
  return code.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

export interface SourceViewOptions {
  metadata_only?: boolean
  start_line?: number
  end_line?: number
}

export function sourceView(result: ShaderFileReadResult, options: SourceViewOptions = {}) {
  const { code, ...shader } = result.shader
  const lines = sourceLines(code)
  const hasRange = options.start_line !== undefined || options.end_line !== undefined
  if (options.metadata_only && hasRange) {
    throw new GodotReaderError("INVALID_READ_ARGUMENTS", "metadata_only cannot be combined with a line range")
  }
  const metadata = { ...shader, hash: shaderHash(code), hash_algorithm: "sha256", utf8_bytes: Buffer.byteLength(code), line_count: lines.length }
  if (options.metadata_only) {
    // This is an index for navigation, never a replacement for official validation.
    const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (value) => value.replace(/[^\r\n]/g, " "))
    const lineAt = (offset: number) => code.slice(0, offset).split("\n").length
    const uniforms = [...masked.matchAll(/\buniform\s+[^;]+;/g)].map((match) => ({
      line: lineAt(match.index!), declaration: code.slice(match.index!, match.index! + match[0].length),
    }))
    const functions = [...masked.matchAll(/\b(?:void|bool|int|uint|float|[biu]?vec[234]|mat[234])\s+([A-Za-z_]\w*)\s*\([^{};]*\)\s*\{/g)].map((match) => ({
      line: lineAt(match.index!), name: match[1], signature: code.slice(match.index!, match.index! + match[0].lastIndexOf("{")).trim(),
    }))
    const { external_resources, internal_resources, ...resource } = result.resource as Record<string, unknown>
    return { ...result, resource, shader: { ...metadata, uniforms, functions, index_method: "lexical" } }
  }
  if (!hasRange) return { ...result, shader: { ...metadata, code } }
  const start = options.start_line ?? 1
  const end = options.end_line ?? lines.length
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) {
    throw new GodotReaderError("INVALID_READ_ARGUMENTS", "Line range must be 1-based, inclusive and within source", {
      details: { start_line: start, end_line: end, line_count: lines.length },
    })
  }
  return { ...result, shader: { ...metadata, code: lines.slice(start - 1, end).join(""), start_line: start, end_line: end, partial: true } }
}

/** Unified diff over exact lines. Bound memory for very large unrelated sources. */
export function unifiedDiff(before: string, after: string, filePath: string): string {
  if (before === after) return ""
  const a = sourceLines(before), b = sourceLines(after)
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++
  const x = a.slice(prefix, a.length - suffix), y = b.slice(prefix, b.length - suffix)
  const edits: Array<{ kind: " " | "+" | "-"; text: string }> = a.slice(0, prefix).map((text) => ({ kind: " ", text }))
  if ((x.length + 1) * (y.length + 1) <= 4_000_000) {
    const width = y.length + 1
    const lcs = new Uint32Array((x.length + 1) * width)
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * width + j] = x[i] === y[j] ? 1 + lcs[(i + 1) * width + j + 1] : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
    let i = 0, j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { edits.push({ kind: " ", text: x[i++] }); j++ }
      else if (i < x.length && (j === y.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) edits.push({ kind: "-", text: x[i++] })
      else edits.push({ kind: "+", text: y[j++] })
    }
  } else {
    edits.push(...x.map((text) => ({ kind: "-" as const, text })), ...y.map((text) => ({ kind: "+" as const, text })))
  }
  edits.push(...a.slice(a.length - suffix).map((text) => ({ kind: " " as const, text })))
  const ranges: Array<[number, number]> = []
  edits.forEach((edit, index) => {
    if (edit.kind === " ") return
    const start = Math.max(0, index - 3), end = Math.min(edits.length, index + 4)
    const last = ranges.at(-1)
    if (last && start <= last[1]) last[1] = end
    else ranges.push([start, end])
  })
  const oldPositions = [0], newPositions = [0]
  for (const edit of edits) {
    oldPositions.push(oldPositions.at(-1)! + Number(edit.kind !== "+"))
    newPositions.push(newPositions.at(-1)! + Number(edit.kind !== "-"))
  }
  const label = JSON.stringify(filePath)
  let diff = `--- ${label}\n+++ ${label}\n`
  for (const [start, end] of ranges) {
    const oldCount = oldPositions[end] - oldPositions[start], newCount = newPositions[end] - newPositions[start]
    diff += `@@ -${oldPositions[start] + Number(oldCount > 0)},${oldCount} +${newPositions[start] + Number(newCount > 0)},${newCount} @@\n`
    for (const edit of edits.slice(start, end)) {
      diff += edit.kind + edit.text
      if (!edit.text.endsWith("\n")) diff += "\n\\ No newline at end of file\n"
    }
  }
  return diff
}
