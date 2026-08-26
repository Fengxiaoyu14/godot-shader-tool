import { BinaryReader } from "./binary-reader.ts"
import { GodotReaderError } from "./errors.ts"
import { readStringReference, readUnicodeString } from "./strings.ts"
import { parseVariant, type ExternalResource, type VariantValue } from "./variant.ts"

const GODOT_VERSION_MAJOR = 3
const GODOT_VERSION_MINOR = 6
const BINARY_FORMAT_VERSION = 3
const RESERVED_FIELD_COUNT = 14
const MAGIC_RSRC = "RSRC"
const MAGIC_SIZE = 4
const VERSION_FIELDS_OFFSET = 2 * 4
const MAX_TABLE_ENTRIES = 1_000_000

export interface InternalResourceEntry {
  path: string
  offset: number
}

export interface ResourceProperty {
  name: string
  value: VariantValue
  offset: number
}

export interface ParsedInternalResource {
  index: number
  path: string
  offset: number
  type: string
  properties: ResourceProperty[]
}

export interface BinaryResourceModel {
  bytes: Uint8Array
  resourceHeaderOffset: number
  bigEndian: boolean
  useReal64: boolean
  versionMajor: number
  versionMinor: number
  formatVersion: number
  type: string
  importMetadataOffset: number
  reservedFields: number[]
  stringTable: string[]
  externalResources: ExternalResource[]
  internalResources: InternalResourceEntry[]
  parsedInternalResources: ParsedInternalResource[]
  footerOffset: number
}

export type GodotResource = BinaryResourceModel

export interface ExtractedShaderResource {
  model: BinaryResourceModel
  root: ParsedInternalResource
  shaderResource: ParsedInternalResource
  shaderSubindex: number
  code: string
}

export function parseBinaryResource(bytes: Uint8Array, resourceHeaderOffset: number): BinaryResourceModel {
  if (
    bytes.byteLength < resourceHeaderOffset + MAGIC_SIZE ||
    asciiAt(bytes, bytes.byteLength - MAGIC_SIZE, MAGIC_SIZE) !== MAGIC_RSRC
  ) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", "Binary resource is missing its RSRC footer", {
      offset: Math.max(0, bytes.byteLength - MAGIC_SIZE),
    })
  }

  const reader = new BinaryReader(bytes, "Godot binary resource")
  reader.seek(resourceHeaderOffset)

  // Godot writes this first flag before enabling endian swapping.
  const bigEndianValue = reader.readU32()
  if (bigEndianValue !== 0) {
    throw new GodotReaderError("UNSUPPORTED_ENDIAN", "Big-endian Godot 3.6 resources are not supported", {
      offset: resourceHeaderOffset,
      details: { big_endian: bigEndianValue },
    })
  }

  const useReal64Value = reader.readU32()
  const versionMajor = reader.readU32()
  const versionMinor = reader.readU32()
  const formatVersion = reader.readU32()

  if (
    versionMajor !== GODOT_VERSION_MAJOR ||
    versionMinor !== GODOT_VERSION_MINOR ||
    formatVersion !== BINARY_FORMAT_VERSION
  ) {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_VERSION", "Only Godot 3.6 binary format version 3 is supported", {
      offset: resourceHeaderOffset + VERSION_FIELDS_OFFSET,
      details: {
        version_major: versionMajor,
        version_minor: versionMinor,
        format_version: formatVersion,
      },
    })
  }

  const type = readUnicodeString(reader)
  const importMetadataOffset = reader.readU64Number("import metadata offset")
  const reservedFields: number[] = []
  for (let index = 0; index < RESERVED_FIELD_COUNT; index++) {
    reservedFields.push(reader.readU32())
  }

  const stringTableSize = readTableCount(reader, "string table")
  const stringTable: string[] = []
  for (let index = 0; index < stringTableSize; index++) {
    stringTable.push(readUnicodeString(reader))
  }

  const externalResourceCount = readTableCount(reader, "external resource table")
  const externalResources: ExternalResource[] = []
  for (let index = 0; index < externalResourceCount; index++) {
    externalResources.push({
      type: readUnicodeString(reader),
      path: readUnicodeString(reader),
    })
  }

  const internalResourceCount = readTableCount(reader, "internal resource table")
  const internalResources: InternalResourceEntry[] = []
  for (let index = 0; index < internalResourceCount; index++) {
    internalResources.push({
      path: readUnicodeString(reader),
      offset: reader.readU64Number("internal resource offset"),
    })
  }

  const footerOffset = bytes.byteLength - MAGIC_SIZE
  for (let index = 0; index < internalResources.length; index++) {
    const entry = internalResources[index]!
    if (entry.offset < reader.tell() || entry.offset >= footerOffset) {
      throw new GodotReaderError("INVALID_BINARY_RESOURCE", `Internal resource ${index} has an invalid offset`, {
        offset: entry.offset,
        details: { table_end: reader.tell(), footer_offset: footerOffset, path: entry.path },
      })
    }
    if (index > 0 && entry.offset <= internalResources[index - 1]!.offset) {
      throw new GodotReaderError("INVALID_BINARY_RESOURCE", "Internal resource offsets are not strictly increasing", {
        offset: entry.offset,
        details: { resource_index: index, path: entry.path },
      })
    }
  }

  const model: BinaryResourceModel = {
    bytes,
    resourceHeaderOffset,
    bigEndian: false,
    useReal64: useReal64Value !== 0,
    versionMajor,
    versionMinor,
    formatVersion,
    type,
    importMetadataOffset,
    reservedFields,
    stringTable,
    externalResources,
    internalResources,
    parsedInternalResources: [],
    footerOffset,
  }
  for (let index = 0; index < internalResources.length; index++) {
    model.parsedInternalResources.push(parseInternalResourceBody(model, index))
  }
  return model
}

export function extractShaderCode(model: BinaryResourceModel): ExtractedShaderResource {
  if (model.type !== "ShaderMaterial") {
    throw new GodotReaderError("NOT_SHADER_MATERIAL", `Expected ShaderMaterial but found ${model.type}`, {
      details: { resource_type: model.type },
    })
  }
  if (model.internalResources.length === 0) {
    throw new GodotReaderError("SHADER_NOT_FOUND", "ShaderMaterial has no internal resources")
  }

  // ResourceInteractiveLoaderBinary treats the final internal resource as the main resource.
  const rootIndex = model.internalResources.length - 1
  const root = parseInternalResource(model, rootIndex)
  if (root.type !== "ShaderMaterial") {
    throw new GodotReaderError("NOT_SHADER_MATERIAL", `Main internal resource is ${root.type}, not ShaderMaterial`, {
      offset: root.offset,
      details: { resource_type: root.type },
    })
  }

  const shaderProperty = root.properties.find((property) => property.name === "shader")
  const shaderReference = shaderProperty?.value.value
  if (
    shaderProperty?.value.type !== "object" ||
    !isRecord(shaderReference) ||
    shaderReference.kind !== "internal_resource" ||
    typeof shaderReference.index !== "number"
  ) {
    throw new GodotReaderError("SHADER_NOT_FOUND", "ShaderMaterial.shader is not an internal Shader resource reference", {
      offset: shaderProperty?.offset,
    })
  }

  const shaderSubindex = shaderReference.index
  const shaderIndex = model.internalResources.findIndex((entry) => entry.path === `local://${shaderSubindex}`)
  if (shaderIndex < 0) {
    throw new GodotReaderError("SHADER_NOT_FOUND", `Internal Shader local://${shaderSubindex} is missing`, {
      offset: shaderProperty.offset,
      details: { subindex: shaderSubindex },
    })
  }

  const shaderResource = parseInternalResource(model, shaderIndex)
  if (shaderResource.type !== "Shader") {
    throw new GodotReaderError("SHADER_NOT_FOUND", `local://${shaderSubindex} is ${shaderResource.type}, not Shader`, {
      offset: shaderResource.offset,
      details: { subindex: shaderSubindex, resource_type: shaderResource.type },
    })
  }

  const codeProperty = shaderResource.properties.find((property) => property.name === "code")
  if (codeProperty === undefined) {
    throw new GodotReaderError("SHADER_CODE_NOT_FOUND", "Internal Shader has no code property", {
      offset: shaderResource.offset,
      details: { subindex: shaderSubindex },
    })
  }
  if (codeProperty.value.type !== "string" || typeof codeProperty.value.value !== "string") {
    throw new GodotReaderError("SHADER_CODE_NOT_STRING", "Internal Shader.code is not a String Variant", {
      offset: codeProperty.offset,
      details: { subindex: shaderSubindex, variant_type_id: codeProperty.value.type_id },
    })
  }
  if (codeProperty.value.value.length === 0) {
    throw new GodotReaderError("SHADER_CODE_NOT_FOUND", "Internal Shader.code is empty", {
      offset: codeProperty.offset,
      details: { subindex: shaderSubindex },
    })
  }

  return {
    model,
    root,
    shaderResource,
    shaderSubindex,
    code: codeProperty.value.value,
  }
}

export function parseInternalResource(model: BinaryResourceModel, index: number): ParsedInternalResource {
  const parsed = model.parsedInternalResources[index]
  if (parsed !== undefined) {
    return parsed
  }
  return parseInternalResourceBody(model, index)
}

function parseInternalResourceBody(model: BinaryResourceModel, index: number): ParsedInternalResource {
  const entry = model.internalResources[index]
  if (entry === undefined) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", `Internal resource index ${index} is out of range`)
  }

  const endOffset = index + 1 < model.internalResources.length ? model.internalResources[index + 1]!.offset : model.footerOffset
  const reader = new BinaryReader(
    model.bytes.subarray(entry.offset, endOffset),
    `internal resource ${index} (${entry.path})`,
    entry.offset,
  )
  const type = readUnicodeString(reader)
  const propertyCount = readTableCount(reader, `${type} property table`)
  const properties: ResourceProperty[] = []

  for (let propertyIndex = 0; propertyIndex < propertyCount; propertyIndex++) {
    const propertyOffset = reader.absoluteOffset()
    const name = readStringReference(reader, model.stringTable)
    if (name.length === 0) {
      throw new GodotReaderError("INVALID_BINARY_RESOURCE", `${type} contains an empty property name`, {
        offset: propertyOffset,
      })
    }
    const value = parseVariant(reader, {
      stringTable: model.stringTable,
      externalResources: model.externalResources,
      resourceType: type,
      propertyName: name,
      formatVersion: model.formatVersion,
    })
    properties.push({ name, value, offset: propertyOffset })
  }

  if (reader.remaining() !== 0) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", `${type} did not consume its complete internal resource span`, {
      offset: reader.absoluteOffset(),
      details: { remaining: reader.remaining(), resource_index: index, path: entry.path },
    })
  }

  return {
    index,
    path: entry.path,
    offset: entry.offset,
    type,
    properties,
  }
}

function readTableCount(reader: BinaryReader, name: string): number {
  const offset = reader.absoluteOffset()
  const count = reader.readU32()
  if (count > MAX_TABLE_ENTRIES) {
    throw new GodotReaderError("INVALID_BINARY_RESOURCE", `${name} exceeds the safety limit`, {
      offset,
      details: { count, limit: MAX_TABLE_ENTRIES },
    })
  }
  return count
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
