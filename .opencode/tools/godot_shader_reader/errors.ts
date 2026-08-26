export type GodotReaderErrorCode =
  | "FILE_NOT_FOUND"
  | "PATH_OUTSIDE_WORKTREE"
  | "INVALID_MAGIC"
  | "INVALID_RSCC_HEADER"
  | "UNSUPPORTED_COMPRESSION"
  | "ZSTD_RUNTIME_UNAVAILABLE"
  | "DECOMPRESSION_FAILED"
  | "DECOMPRESSION_SIZE_MISMATCH"
  | "INVALID_BINARY_RESOURCE"
  | "UNSUPPORTED_RESOURCE_VERSION"
  | "UNSUPPORTED_ENDIAN"
  | "UNSUPPORTED_VARIANT_TYPE"
  | "NOT_SHADER_MATERIAL"
  | "SHADER_NOT_FOUND"
  | "SHADER_CODE_NOT_FOUND"
  | "OUT_OF_BOUNDS"
  | "INTERNAL_ERROR"

export interface PublicError {
  code: GodotReaderErrorCode
  message: string
  offset?: number
  details?: Record<string, unknown>
}

export class GodotReaderError extends Error {
  readonly code: GodotReaderErrorCode
  readonly offset?: number
  readonly details?: Record<string, unknown>

  constructor(
    code: GodotReaderErrorCode,
    message: string,
    options: {
      offset?: number
      details?: Record<string, unknown>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "GodotReaderError"
    this.code = code
    this.offset = options.offset
    this.details = options.details
  }
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof GodotReaderError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.offset === undefined ? {} : { offset: error.offset }),
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unexpected internal error",
  }
}
