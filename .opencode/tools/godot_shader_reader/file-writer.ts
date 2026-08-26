import { randomUUID } from "node:crypto"
import { open, readFile, rename, unlink } from "node:fs/promises"
import path from "node:path"

import {
  parseResource,
  rewriteShaderCode,
  validateContainerPreserved,
  validateShaderOnlyChange,
  type ZstdDecoder,
  type ZstdEncoder,
} from "./codec.ts"
import { GodotReaderError } from "./errors.ts"
import { extractShaderCode } from "./resource.ts"
import {
  validateGodot36Shader,
  type ShaderValidationResult,
  type ShaderValidator,
} from "./validator.ts"

export interface ShaderWriteValidation {
  pre_write_shader: true
  resource_read_back: true
  shader_code_match: true
  semantic_diff: true
  post_write_shader: true
}

export interface ShaderFileWriteResult {
  resource_type: string
  validation: ShaderWriteValidation
  before: { shader_length: number }
  after: { shader_length: number }
}

export interface ShaderFileWriteOptions {
  zstdDecoder?: ZstdDecoder
  zstdEncoder?: ZstdEncoder
  shaderValidator?: ShaderValidator
}

export interface SafeReplaceOptions {
  platform?: NodeJS.Platform
  renameFile?: typeof rename
  unlinkFile?: typeof unlink
  backupPath?: string
}

export async function writeGodotShaderFile(
  targetPath: string,
  shaderCode: string,
  options: ShaderFileWriteOptions = {},
): Promise<ShaderFileWriteResult> {
  const shaderValidator = options.shaderValidator ?? validateGodot36Shader
  await requireValidShader(shaderCode, shaderValidator, "pre_write")

  const originalBytes = await readFile(targetPath)
  const rewritten = rewriteShaderCode(
    originalBytes,
    shaderCode,
    options.zstdDecoder,
    options.zstdEncoder,
  )

  const tempPath = siblingPath(targetPath, "opencode-tmp")
  let tempExists = false
  try {
    try {
      const handle = await open(tempPath, "wx", 0o600)
      tempExists = true
      try {
        await handle.writeFile(rewritten.bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (cause) {
      throw new GodotReaderError("TEMP_WRITE_FAILED", "Could not write the validated sibling temporary file", {
        cause,
      })
    }

    let readBack
    try {
      const tempBytes = await readFile(tempPath)
      readBack = parseResource(tempBytes, options.zstdDecoder)
    } catch (cause) {
      throw new GodotReaderError("READ_BACK_FAILED", "Sibling temporary file could not be read back", { cause })
    }
    validateContainerPreserved(rewritten.before.container, readBack.container)
    const validation = validateShaderOnlyChange(rewritten.before.resource, readBack.resource, shaderCode)
    const afterShader = extractShaderCode(readBack.resource)
    await requireValidShader(afterShader.code, shaderValidator, "post_write")

    const currentBytes = await readFile(targetPath)
    if (!bytesEqual(originalBytes, currentBytes)) {
      throw new GodotReaderError(
        "UNEXPECTED_RESOURCE_CHANGE",
        "The original material changed while the replacement was being prepared",
      )
    }

    await replaceFileSafely(tempPath, targetPath)
    tempExists = false
    const beforeShader = extractShaderCode(rewritten.before.resource)
    return {
      resource_type: readBack.resource.type,
      validation: {
        pre_write_shader: true,
        resource_read_back: validation.read_back,
        shader_code_match: validation.shader_code_match,
        semantic_diff: validation.only_shader_changed,
        post_write_shader: true,
      },
      before: { shader_length: beforeShader.code.length },
      after: { shader_length: afterShader.code.length },
    }
  } finally {
    if (tempExists) {
      await unlink(tempPath).catch(() => undefined)
    }
  }
}

async function requireValidShader(
  shaderCode: string,
  validator: ShaderValidator,
  phase: "pre_write" | "post_write",
): Promise<void> {
  let result: ShaderValidationResult
  try {
    result = await validator(shaderCode)
  } catch (error) {
    if (error instanceof GodotReaderError && isValidatorError(error.code)) {
      throw new GodotReaderError(error.code, error.message, {
        line: error.line,
        offset: error.offset,
        details: { ...error.details, phase },
        cause: error,
      })
    }
    throw new GodotReaderError("SHADER_VALIDATOR_FAILED", `Godot shader validator failed during ${phase}`, {
      details: { phase },
      cause: error,
    })
  }

  if (!result.valid) {
    throw new GodotReaderError("SHADER_VALIDATION_FAILED", result.error.message, {
      line: result.error.line,
      details: {
        phase,
        godot_version: result.godot_version,
        renderer: result.renderer,
        ...(result.shader_type === undefined ? {} : { shader_type: result.shader_type }),
      },
    })
  }
}

function isValidatorError(code: GodotReaderError["code"]): boolean {
  return code === "SHADER_VALIDATOR_UNAVAILABLE" ||
    code === "SHADER_VALIDATOR_FAILED" ||
    code === "SHADER_VALIDATOR_TIMEOUT" ||
    code === "INVALID_VALIDATOR_RESPONSE"
}

export async function replaceFileSafely(
  tempPath: string,
  targetPath: string,
  options: SafeReplaceOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  const renameFile = options.renameFile ?? rename
  const unlinkFile = options.unlinkFile ?? unlink
  if (platform !== "win32") {
    try {
      await renameFile(tempPath, targetPath)
      return
    } catch (cause) {
      throw new GodotReaderError("ATOMIC_REPLACE_FAILED", "Atomic replacement of the original material failed", {
        cause,
      })
    }
  }

  const backupPath = options.backupPath ?? siblingPath(targetPath, "opencode-replace-backup")
  try {
    await renameFile(targetPath, backupPath)
  } catch (cause) {
    throw new GodotReaderError("ATOMIC_REPLACE_FAILED", "Could not stage the original material for Windows replacement", {
      cause,
    })
  }

  try {
    await renameFile(tempPath, targetPath)
  } catch (cause) {
    try {
      await renameFile(backupPath, targetPath)
    } catch (restoreCause) {
      throw new GodotReaderError(
        "ATOMIC_REPLACE_FAILED",
        "Replacement failed and the original material could not be restored to its original path",
        {
          details: { recoverable_backup_path: backupPath },
          cause: new AggregateError([cause, restoreCause], "Windows replacement and restoration both failed"),
        },
      )
    }
    throw new GodotReaderError("ATOMIC_REPLACE_FAILED", "Windows replacement failed; the original was restored", {
      cause,
    })
  }

  await unlinkFile(backupPath).catch(() => undefined)
}

function siblingPath(targetPath: string, label: string): string {
  return path.join(path.dirname(targetPath), `${path.basename(targetPath)}.${label}-${randomUUID()}`)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}
