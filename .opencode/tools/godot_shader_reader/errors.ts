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
  | "SHADER_CODE_NOT_STRING"
  | "INVALID_SHADER_CODE"
  | "INVALID_VALIDATE_ARGUMENTS"
  | "SHADER_VALIDATION_FAILED"
  | "SHADER_VALIDATOR_UNAVAILABLE"
  | "SHADER_VALIDATOR_FAILED"
  | "SHADER_VALIDATOR_TIMEOUT"
  | "INVALID_VALIDATOR_RESPONSE"
  | "UNSUPPORTED_VARIANT_FOR_WRITE"
  | "UNSUPPORTED_RESOURCE_FOR_WRITE"
  | "SERIALIZATION_FAILED"
  | "COMPRESSION_FAILED"
  | "TEMP_WRITE_FAILED"
  | "READ_BACK_FAILED"
  | "SHADER_VERIFY_FAILED"
  | "UNEXPECTED_RESOURCE_CHANGE"
  | "ATOMIC_REPLACE_FAILED"
  | "OUT_OF_BOUNDS"
  | "INTERNAL_ERROR"

export interface PublicError {
  code: GodotReaderErrorCode
  message: string
  line?: number
  offset?: number
  details?: Record<string, unknown>
}

export class GodotReaderError extends Error {
  readonly code: GodotReaderErrorCode
  readonly line?: number
  readonly offset?: number
  readonly details?: Record<string, unknown>

  constructor(
    code: GodotReaderErrorCode,
    message: string,
    options: {
      line?: number
      offset?: number
      details?: Record<string, unknown>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "GodotReaderError"
    this.code = code
    this.line = options.line
    this.offset = options.offset
    this.details = options.details
  }
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof GodotReaderError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.line === undefined ? {} : { line: error.line }),
      ...(error.offset === undefined ? {} : { offset: error.offset }),
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unexpected internal error",
  }
}
