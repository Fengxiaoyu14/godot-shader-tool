import { readFile, realpath, stat } from "node:fs/promises"

import { parseResource } from "./codec.ts"
import { GodotReaderError } from "./errors.ts"
import { resolveInputPath } from "./input-path.ts"
import { extractShaderCode } from "./resource.ts"
import { validateGodot36Shader, type ShaderValidationResult, type ShaderValidator } from "./validator.ts"

export interface ShaderValidationRequest {
  shader_code?: string
  path?: string
}

export interface ShaderValidationRequestOptions {
  validator?: ShaderValidator
}

export async function validateShaderRequest(
  request: ShaderValidationRequest,
  worktree: string,
  options: ShaderValidationRequestOptions = {},
): Promise<ShaderValidationResult> {
  const hasShaderCode = request.shader_code !== undefined
  const hasPath = request.path !== undefined
  if (hasShaderCode === hasPath) {
    throw new GodotReaderError(
      "INVALID_VALIDATE_ARGUMENTS",
      "Provide exactly one of shader_code or path",
    )
  }

  const validator = options.validator ?? validateGodot36Shader
  if (hasShaderCode) {
    return validator(request.shader_code!)
  }

  const requested = resolveInputPath(request.path!, worktree)
  let resolved: string
  try {
    resolved = await realpath(requested)
  } catch (cause) {
    throw new GodotReaderError("FILE_NOT_FOUND", `File not found: ${request.path}`, { cause })
  }
  const fileStat = await stat(resolved)
  if (!fileStat.isFile()) {
    throw new GodotReaderError("FILE_NOT_FOUND", `Not a regular file: ${request.path}`)
  }

  const material = parseResource(await readFile(resolved))
  return validator(extractShaderCode(material.resource).code)
}
