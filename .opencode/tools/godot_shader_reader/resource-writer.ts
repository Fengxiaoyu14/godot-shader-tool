import { BinaryWriter } from "./binary-writer.ts"
import { GodotReaderError } from "./errors.ts"
import { writeStringReference, writeUnicodeString } from "./strings.ts"
import { writeVariant } from "./variant-writer.ts"
import type { GodotResource } from "./resource.ts"

const MAGIC_RSRC = "RSRC"
const RESERVED_FIELD_COUNT = 14

export interface BinaryResourceWriteOptions {
  includeMagicHeader: boolean
}

export function serializeBinaryResource(
  resource: GodotResource,
  options: BinaryResourceWriteOptions,
): Uint8Array {
  validateWritableResource(resource)
  const writer = new BinaryWriter()
  if (options.includeMagicHeader) {
    writer.writeUtf8(MAGIC_RSRC)
  }

  writer.writeU32(0)
  writer.writeU32(resource.useReal64 ? 1 : 0)
  writer.writeU32(resource.versionMajor)
  writer.writeU32(resource.versionMinor)
  writer.writeU32(resource.formatVersion)
  writeUnicodeString(writer, resource.type)
  writer.writeU64(resource.importMetadataOffset)
  for (const reserved of resource.reservedFields) {
    writer.writeU32(reserved)
  }

  const stringTable = buildStringTable(resource)
  const stringIndexes = new Map(stringTable.map((value, index) => [value, index]))
  writer.writeU32(stringTable.length)
  for (const value of stringTable) {
    writeUnicodeString(writer, value)
  }

  writer.writeU32(resource.externalResources.length)
  for (const external of resource.externalResources) {
    writeUnicodeString(writer, external.type)
    writeUnicodeString(writer, external.path)
  }

  writer.writeU32(resource.parsedInternalResources.length)
  const offsetPatches: number[] = []
  for (const internal of resource.parsedInternalResources) {
    writeUnicodeString(writer, internal.path)
    offsetPatches.push(writer.reserve(8))
  }

  for (let index = 0; index < resource.parsedInternalResources.length; index++) {
    const internal = resource.parsedInternalResources[index]!
    writer.patchU64(offsetPatches[index]!, writer.tell())
    writeUnicodeString(writer, internal.type)
    writer.writeU32(internal.properties.length)
    for (const property of internal.properties) {
      writeStringReference(writer, property.name, stringIndexes)
      writeVariant(writer, property.value, {
        stringIndexes,
        resourceType: internal.type,
        propertyName: property.name,
      })
    }
  }

  writer.writeUtf8(MAGIC_RSRC)
  return writer.toUint8Array()
}

function buildStringTable(resource: GodotResource): string[] {
  const strings = [...resource.stringTable]
  const seen = new Set(strings)
  for (const internal of resource.parsedInternalResources) {
    for (const property of internal.properties) {
      if (!seen.has(property.name)) {
        seen.add(property.name)
        strings.push(property.name)
      }
    }
  }
  return strings
}

function validateWritableResource(resource: GodotResource): void {
  if (resource.bigEndian) {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_FOR_WRITE", "Big-endian resources cannot be written safely")
  }
  if (resource.versionMajor !== 3 || resource.versionMinor !== 6 || resource.formatVersion !== 3) {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_FOR_WRITE", "Only Godot 3.6 binary format version 3 can be written")
  }
  if (resource.importMetadataOffset !== 0) {
    throw new GodotReaderError(
      "UNSUPPORTED_RESOURCE_FOR_WRITE",
      "Resources with import metadata cannot be written because the metadata payload is not modeled",
      { details: { import_metadata_offset: resource.importMetadataOffset } },
    )
  }
  if (resource.reservedFields.length !== RESERVED_FIELD_COUNT) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "Godot 3.6 resource must contain 14 reserved header fields", {
      details: { reserved_field_count: resource.reservedFields.length },
    })
  }
  if (resource.parsedInternalResources.length !== resource.internalResources.length) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "The parsed internal-resource model is incomplete", {
      details: {
        table_count: resource.internalResources.length,
        parsed_count: resource.parsedInternalResources.length,
      },
    })
  }
  for (let index = 0; index < resource.parsedInternalResources.length; index++) {
    const parsed = resource.parsedInternalResources[index]!
    const table = resource.internalResources[index]!
    if (parsed.index !== index || parsed.path !== table.path) {
      throw new GodotReaderError("SERIALIZATION_FAILED", "Internal-resource table and IR are inconsistent", {
        details: { resource_index: index, table_path: table.path, parsed_path: parsed.path },
      })
    }
  }
}
