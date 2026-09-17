import { GodotReaderError } from "./errors.ts"
import { sourceLines } from "./source-info.ts"

export type ShaderPatchOp =
  | { find: string; replace: string; expect: number }
  | { delete_lines: [number, number]; expect: number; expected_text: string }

/** Validate unknown JSON explicitly; misspelled fields must never be ignored. */
export function parsePatchOps(value: unknown): ShaderPatchOp[] {
  if (!Array.isArray(value) || value.length === 0) throw new GodotReaderError("INVALID_PATCH", "ops must be a non-empty array")
  return value.map((op, index) => {
    const invalid = () => new GodotReaderError("INVALID_PATCH", "Each op needs literal find/replace/expect or delete_lines/expected_text/expect", { details: { op_index: index } })
    if (!op || typeof op !== "object" || !Number.isSafeInteger(op.expect) || op.expect < 1) throw invalid()
    if (typeof op.find === "string" && op.find.length > 0 && typeof op.replace === "string" && Object.keys(op).every((k) => ["find", "replace", "expect"].includes(k))) {
      return { find: op.find, replace: op.replace, expect: op.expect }
    }
    if (Array.isArray(op.delete_lines) && op.delete_lines.length === 2 && op.delete_lines.every((n: unknown) => Number.isSafeInteger(n) && Number(n) >= 1) &&
        op.delete_lines[1] >= op.delete_lines[0] && op.expect === 1 && typeof op.expected_text === "string" && op.expected_text.length > 0 &&
        Object.keys(op).every((k) => ["delete_lines", "expected_text", "expect"].includes(k))) {
      return { delete_lines: [...op.delete_lines] as [number, number], expected_text: op.expected_text, expect: 1 }
    }
    throw invalid()
  })
}

/** Sequential in-memory operations. No IO occurs, including after partial success. */
export function applyShaderPatch(code: string, operations: unknown): string {
  const ops = parsePatchOps(operations)
  for (const [index, op] of ops.entries()) {
    if ("find" in op) {
      const chunks = code.split(op.find)
      const count = chunks.length - 1
      if (count !== op.expect) throw mismatch(index, op.expect, count)
      // join is literal: $&, $1, backslashes and newlines have no replacement syntax.
      code = chunks.join(op.replace)
    } else {
      const lines = sourceLines(code)
      const [start, end] = op.delete_lines
      const actual = lines.slice(start - 1, end).join("")
      if (end > lines.length || actual !== op.expected_text) throw mismatch(index, 1, 0)
      lines.splice(start - 1, end - start + 1)
      code = lines.join("")
    }
  }
  return code
}

function mismatch(index: number, expected: number, actual: number): GodotReaderError {
  return new GodotReaderError("PATCH_EXPECT_MISMATCH", "Patch assertion failed; no operations were written", {
    details: { op_index: index, expected, actual },
  })
}
