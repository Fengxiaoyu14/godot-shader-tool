import { randomUUID } from "node:crypto"
import { open, readFile, rename, unlink } from "node:fs/promises"
import path from "node:path"

import {
  parseResource,
  rewriteShaderCode,
  validateContainerPreserved,
  validateShaderOnlyChange,
  type ShaderOnlyValidation,
  type ZstdDecoder,
  type ZstdEncoder,
} from "./codec.ts"
import { GodotReaderError } from "./errors.ts"
import { extractShaderCode } from "./resource.ts"

export interface ShaderFileWriteResult {
  resource_type: string
  validation: ShaderOnlyValidation
  before: { shader_length: number }
  after: { shader_length: number }
}

export interface ShaderFileWriteOptions {
  zstdDecoder?: ZstdDecoder
  zstdEncoder?: ZstdEncoder
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
    const afterShader = extractShaderCode(readBack.resource)
    return {
      resource_type: readBack.resource.type,
      validation,
      before: { shader_length: beforeShader.code.length },
      after: { shader_length: afterShader.code.length },
    }
  } finally {
    if (tempExists) {
      await unlink(tempPath).catch(() => undefined)
    }
  }
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
