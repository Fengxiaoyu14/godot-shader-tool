import { GodotReaderError } from "./errors.ts"
import { extractShaderCode, parseBinaryResource, type GodotResource } from "./resource.ts"
import { serializeBinaryResource } from "./resource-writer.ts"
import { openGodotContainer, type ContainerMetadata, type ZstdDecoder } from "./rscc.ts"
import { encodeGodotContainer, type ZstdEncoder } from "./rscc-writer.ts"
import { encodeUtf8Exact } from "./strings.ts"

export interface ParsedResource {
  container: ContainerMetadata
  resource: GodotResource
}

export interface ShaderOnlyValidation {
  read_back: true
  shader_code_match: true
  only_shader_changed: true
}

export interface RewriteShaderResult {
  bytes: Uint8Array
  before: ParsedResource
  after: ParsedResource
  validation: ShaderOnlyValidation
}

export function parseResource(bytes: Uint8Array, zstdDecoder?: ZstdDecoder): ParsedResource {
  const opened = openGodotContainer(bytes, zstdDecoder)
  return {
    container: opened.metadata,
    resource: parseBinaryResource(opened.resourceBytes, opened.resourceHeaderOffset),
  }
}

export function getShaderCode(resource: GodotResource): string {
  return extractShaderCode(resource).code
}

export function setShaderCode(resource: GodotResource, code: string): void {
  if (code.length === 0) {
    throw new GodotReaderError("INVALID_SHADER_CODE", "shader_code must not be empty")
  }
  try {
    encodeUtf8Exact(code)
  } catch (cause) {
    throw new GodotReaderError("INVALID_SHADER_CODE", "shader_code must be losslessly encodable as UTF-8", { cause })
  }

  const extracted = extractShaderCode(resource)
  const property = extracted.shaderResource.properties.find((candidate) => candidate.name === "code")
  if (property?.value.type !== "string" || property.value.type_id !== 5) {
    throw new GodotReaderError("SHADER_CODE_NOT_STRING", "Internal Shader.code is not a Godot String Variant", {
      details: { subindex: extracted.shaderSubindex },
    })
  }
  property.value.value = code
}

export function serializeResource(parsed: ParsedResource, zstdEncoder?: ZstdEncoder): Uint8Array {
  const logical = serializeBinaryResource(parsed.resource, {
    includeMagicHeader: parsed.container.format === "RSRC",
  })
  return encodeGodotContainer(logical, parsed.container, zstdEncoder)
}

export function rewriteShaderCode(
  originalBytes: Uint8Array,
  requestedCode: string,
  zstdDecoder?: ZstdDecoder,
  zstdEncoder?: ZstdEncoder,
): RewriteShaderResult {
  const before = parseResource(originalBytes, zstdDecoder)
  const working = parseResource(originalBytes, zstdDecoder)
  setShaderCode(working.resource, requestedCode)
  const bytes = serializeResource(working, zstdEncoder)

  let after: ParsedResource
  try {
    after = parseResource(bytes, zstdDecoder)
  } catch (cause) {
    throw new GodotReaderError("READ_BACK_FAILED", "Serialized resource could not be read back", { cause })
  }
  validateContainerPreserved(before.container, after.container)
  const validation = validateShaderOnlyChange(before.resource, after.resource, requestedCode)
  return { bytes, before, after, validation }
}

export function validateContainerPreserved(before: ContainerMetadata, after: ContainerMetadata): void {
  compare(before.format, after.format, "container.format")
  if (before.format === "RSCC") {
    compare(before.compression_mode, after.compression_mode, "container.compression_mode")
    compare(before.block_size, after.block_size, "container.block_size")
  }
}

export function validateShaderOnlyChange(
  before: GodotResource,
  after: GodotResource,
  requestedCode: string,
): ShaderOnlyValidation {
  const beforeShader = extractShaderCode(before)
  const afterShader = extractShaderCode(after)
  if (afterShader.code !== requestedCode) {
    throw new GodotReaderError("SHADER_VERIFY_FAILED", "Read-back Shader.code does not match shader_code", {
      details: { requested_length: requestedCode.length, read_back_length: afterShader.code.length },
    })
  }

  compare(before.type, after.type, "resource.type")
  compare(before.bigEndian, after.bigEndian, "resource.big_endian")
  compare(before.useReal64, after.useReal64, "resource.use_real64")
  compare(before.versionMajor, after.versionMajor, "resource.version_major")
  compare(before.versionMinor, after.versionMinor, "resource.version_minor")
  compare(before.formatVersion, after.formatVersion, "resource.format_version")
  compare(before.importMetadataOffset, after.importMetadataOffset, "resource.import_metadata_offset")
  compareSemantic(before.reservedFields, after.reservedFields, "resource.reserved_fields")
  compareSemantic(before.externalResources, after.externalResources, "resource.external_resources")
  compare(before.parsedInternalResources.length, after.parsedInternalResources.length, "resource.internal_count")
  compare(beforeShader.shaderSubindex, afterShader.shaderSubindex, "shader.subindex")
  compare(beforeShader.shaderResource.index, afterShader.shaderResource.index, "shader.internal_resource_index")

  for (let resourceIndex = 0; resourceIndex < before.parsedInternalResources.length; resourceIndex++) {
    const original = before.parsedInternalResources[resourceIndex]!
    const written = after.parsedInternalResources[resourceIndex]!
    compare(original.path, written.path, `internal[${resourceIndex}].path`)
    compare(original.type, written.type, `internal[${resourceIndex}].type`)
    compare(original.properties.length, written.properties.length, `internal[${resourceIndex}].property_count`)
    for (let propertyIndex = 0; propertyIndex < original.properties.length; propertyIndex++) {
      const originalProperty = original.properties[propertyIndex]!
      const writtenProperty = written.properties[propertyIndex]!
      const propertyPath = `internal[${resourceIndex}].properties[${propertyIndex}]`
      compare(originalProperty.name, writtenProperty.name, `${propertyPath}.name`)
      if (
        resourceIndex === beforeShader.shaderResource.index &&
        propertyIndex === beforeShader.shaderResource.properties.findIndex((property) => property.name === "code")
      ) {
        compare(writtenProperty.value.type, "string", `${propertyPath}.value.type`)
        compare(writtenProperty.value.type_id, 5, `${propertyPath}.value.type_id`)
        compare(writtenProperty.value.value, requestedCode, `${propertyPath}.value.value`)
      } else {
        compareSemantic(originalProperty.value, writtenProperty.value, `${propertyPath}.value`)
      }
    }
  }

  return { read_back: true, shader_code_match: true, only_shader_changed: true }
}

function compareSemantic(before: unknown, after: unknown, path: string): void {
  if (!semanticEqual(before, after)) {
    unexpected(path)
  }
}

function compare(before: unknown, after: unknown, path: string): void {
  if (!Object.is(before, after)) {
    unexpected(path, before, after)
  }
}

function unexpected(path: string, before?: unknown, after?: unknown): never {
  throw new GodotReaderError("UNEXPECTED_RESOURCE_CHANGE", `Unexpected resource change at ${path}`, {
    details: {
      path,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    },
  })
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) {
      return false
    }
    return left.every((value, index) => value === right[index])
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => semanticEqual(value, right[index]))
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false
    }
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (!semanticEqual(leftKeys, rightKeys)) {
      return false
    }
    return leftKeys.every((key) => semanticEqual(left[key], right[key]))
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export type { ZstdEncoder } from "./rscc-writer.ts"
export type { ZstdDecoder } from "./rscc.ts"
export type { GodotResource } from "./resource.ts"
export type { VariantValue } from "./variant.ts"
