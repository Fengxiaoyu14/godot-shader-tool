import { readGodotShaderFile } from "./file-reader.ts"
import { GodotReaderError } from "./errors.ts"
import { resolveInputPath } from "./input-path.ts"
import type { ZstdDecoder } from "./rscc.ts"
import { validateGodot36Shader, type ShaderValidationResult, type ShaderValidator } from "./validator.ts"

export interface ShaderValidationRequest {
  shader_code?: string
  path?: string
  project_root?: string
  shader_path?: string
}

export interface ShaderValidationRequestOptions {
  validator?: ShaderValidator
  zstdDecoder?: ZstdDecoder
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
    if (request.project_root !== undefined || request.shader_path !== undefined) {
      throw new GodotReaderError("INVALID_VALIDATE_ARGUMENTS", "project_root and shader_path require path input")
    }
    return validator(request.shader_code!)
  }

  const result = await readGodotShaderFile(resolveInputPath(request.path!, worktree), {
    ...(request.project_root === undefined ? {} : { projectRoot: resolveInputPath(request.project_root, worktree) }),
    ...(request.shader_path === undefined ? {} : { shaderPath: resolveInputPath(request.shader_path, worktree) }),
    zstdDecoder: options.zstdDecoder,
  })
  return validator(result.shader.code)
}
