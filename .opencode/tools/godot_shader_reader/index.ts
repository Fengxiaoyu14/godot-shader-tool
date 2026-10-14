export { readGodot36Shader } from "./shader-reader.ts"
export type { ShaderReadResult } from "./shader-reader.ts"
export { readGodotShaderFile } from "./file-reader.ts"
export type { ShaderFileReadOptions, ShaderFileReadResult } from "./file-reader.ts"
export { writeGodotShaderFile, patchGodotShaderFile } from "./file-writer.ts"
export { applyShaderPatch, parsePatchOps } from "./patch.ts"
export { applyShaderPlan } from "./batch.ts"
export { shaderHash, sourceView, unifiedDiff } from "./source-info.ts"
export { searchGodotShaders } from "./search.ts"

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
export { materialParams, uniformIndex, resourceHash } from "./material-params.ts"
export { diffGodotMaterials } from "./material-diff.ts"
