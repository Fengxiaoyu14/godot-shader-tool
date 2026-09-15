import path from "node:path"
import { parseResource, rewriteShaderCode, validateContainerPreserved, validateShaderOnlyChange } from "./codec.ts"
import { extractShaderCode } from "./resource.ts"
import { GodotReaderError } from "./errors.ts"
import { decodeShaderUtf8, inspectTextShader } from "./text-shader.ts"
import { encodeUtf8Exact } from "./strings.ts"
import type { ZstdDecoder } from "./rscc.ts"
import type { ZstdEncoder } from "./rscc-writer.ts"

export interface PreparedShaderWrite {
  bytes: Uint8Array
  beforeCode: string
  resourceType: string
  verify(bytes: Uint8Array): string
}

export function prepareShaderWrite(
  original: Uint8Array, filePath: string, code: string,
  options: { zstdDecoder?: ZstdDecoder; zstdEncoder?: ZstdEncoder },
): PreparedShaderWrite {
  if (!code.length) throw new GodotReaderError("INVALID_SHADER_CODE", "shader_code must not be empty")
  try {
    encodeUtf8Exact(code)
  } catch (cause) {
    throw new GodotReaderError("INVALID_SHADER_CODE", "shader_code must be losslessly encodable as UTF-8", { cause })
  }
  const magic = String.fromCharCode(...original.subarray(0, 4))
  if (magic === "RSCC" || magic === "RSRC") {
    const rewritten = rewriteShaderCode(original, code, options.zstdDecoder, options.zstdEncoder)
    return {
      bytes: rewritten.bytes,
      beforeCode: extractShaderCode(rewritten.before.resource).code,
      resourceType: rewritten.before.resource.type,
      verify(bytes) {
        const readBack = parseResource(bytes, options.zstdDecoder)
        validateContainerPreserved(rewritten.before.container, readBack.container)
        validateShaderOnlyChange(rewritten.before.resource, readBack.resource, code)
        return extractShaderCode(readBack.resource).code
      },
    }
  }

  const originalText = decodeShaderUtf8(original, true)
  const raw = [".shader", ".gdshader"].includes(path.extname(filePath).toLowerCase())
  const inspected = raw ? undefined : inspectTextShader(originalText)
  const beforeCode = inspected?.code ?? decodeShaderUtf8(original)
  const prefix = inspected ? originalText.slice(0, inspected.start) : originalText.startsWith("\uFEFF") ? "\uFEFF" : ""
  const suffix = inspected ? originalText.slice(inspected.end) : ""
  const output = prefix + (inspected ? JSON.stringify(code) : code) + suffix
  return {
    bytes: new TextEncoder().encode(output), beforeCode, resourceType: "Shader",
    verify(bytes) {
      const text = decodeShaderUtf8(bytes, true)
      const parsed = raw ? undefined : inspectTextShader(text)
      const actual = parsed?.code ?? decodeShaderUtf8(bytes)
      if (actual !== code) throw new GodotReaderError("SHADER_VERIFY_FAILED", "Read-back Shader.code does not match shader_code")
      if (parsed && (text.slice(0, parsed.start) !== prefix || text.slice(parsed.end) !== suffix)) {
        throw new GodotReaderError("UNEXPECTED_RESOURCE_CHANGE", "Text outside root Shader.code changed")
      }
      if (!parsed && text !== output) {
        throw new GodotReaderError("UNEXPECTED_RESOURCE_CHANGE", "Unexpected source encoding change")
      }
      return actual
    },
  }
}
