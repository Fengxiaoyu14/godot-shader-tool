export { readGodot36Shader } from "./shader-reader.ts"
export type { ShaderReadResult } from "./shader-reader.ts"
export { readGodotShaderFile } from "./file-reader.ts"
export type { ShaderFileReadOptions, ShaderFileReadResult } from "./file-reader.ts"

export { GodotReaderError, toPublicError } from "./errors.ts"
export { openGodotContainer, defaultZstdDecoder } from "./rscc.ts"
export { extractShaderCode, parseBinaryResource, parseInternalResource } from "./resource.ts"
export {
  getShaderCode,
  parseResource,
  rewriteShaderCode,
  serializeResource,
  setShaderCode,
  validateContainerPreserved,
  validateShaderOnlyChange,
} from "./codec.ts"
export { defaultZstdEncoder, encodeGodotContainer } from "./rscc-writer.ts"
export { serializeBinaryResource } from "./resource-writer.ts"
export { bundledValidatorPath, validateGodot36Shader } from "./validator.ts"
export { validateShaderRequest } from "./validation-tool.ts"
export type {
  ShaderValidationFailure,
  ShaderValidationResult,
  ShaderValidationSuccess,
  ShaderValidator,
} from "./validator.ts"
