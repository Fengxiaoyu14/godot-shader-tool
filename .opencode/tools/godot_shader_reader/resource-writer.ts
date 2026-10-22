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
  // Preserve this unused legacy header field, including uint64 wraparound
  // values produced by Godot's dependency renamer. It is not a live offset.
  writer.writeU64(typeof resource.importMetadataOffset === "string"
    ? BigInt(resource.importMetadataOffset)
    : resource.importMetadataOffset)
  for (const [index, reserved] of resource.reservedFields.entries()) {
    if (resource.versionMajor === 4 && index === 3 && (resource.reservedFields[0]! & 8)) {
      writeUnicodeString(writer, resource.scriptClass ?? "")
    }
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
    if (resource.versionMajor === 4 && (resource.reservedFields[0]! & 2)) writer.writeU64(BigInt(external.uid ?? "18446744073709551615"))
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
        versionMajor: resource.versionMajor,
        real64: resource.versionMajor === 4 && !!(resource.reservedFields[0]! & 4),
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
  if (!(resource.versionMajor === 3 && [5, 6].includes(resource.versionMinor) && resource.formatVersion === 3) &&
    !(resource.versionMajor === 4 && resource.versionMinor >= 0 && resource.formatVersion >= 3 && resource.formatVersion <= 6)) {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_FOR_WRITE", "Supported write formats: Godot 3.5/3.6 format 3 and Godot 4.x formats 3 through 6")
  }
  if (typeof resource.importMetadataOffset === "string" && !/^(0|[1-9][0-9]{0,19})$/.test(resource.importMetadataOffset)) {
    throw new GodotReaderError(
      "SERIALIZATION_FAILED",
      "Legacy import metadata field must be an unsigned decimal uint64",
      { details: { import_metadata_offset: resource.importMetadataOffset } },
    )
  }
  if (resource.reservedFields.length !== RESERVED_FIELD_COUNT) {
    throw new GodotReaderError("SERIALIZATION_FAILED", "Resource header must contain 14 fixed header words", {
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
