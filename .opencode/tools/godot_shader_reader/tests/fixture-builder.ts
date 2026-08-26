import { Buffer } from "node:buffer"
import { zstdCompressSync } from "node:zlib"

export interface EncodedProperty {
  name: string
  value: Uint8Array
}

export interface EncodedResource {
  path: string
  type: string
  properties: EncodedProperty[]
}

export function buildBinaryResource(resourceType: string, resources: readonly EncodedResource[]): Uint8Array {
  const propertyNames = [...new Set(resources.flatMap((resource) => resource.properties.map((property) => property.name)))]
  const stringIndexes = new Map(propertyNames.map((name, index) => [name, index]))

  const resourceBodies = resources.map((resource) =>
    concat(
      unicode(resource.type),
      u32(resource.properties.length),
      ...resource.properties.flatMap((property) => [
        u32(requiredIndex(stringIndexes, property.name)),
        property.value,
      ]),
    ),
  )

  const fixedHeader = concat(
    ascii("RSRC"),
    u32(0),
    u32(0),
    u32(3),
    u32(6),
    u32(3),
    unicode(resourceType),
    u64(0),
    ...Array.from({ length: 14 }, () => u32(0)),
    u32(propertyNames.length),
    ...propertyNames.map(unicode),
    u32(0),
    u32(resources.length),
  )

  const tableSize = resources.reduce((sum, resource) => sum + unicode(resource.path).byteLength + 8, 0)
  let resourceOffset = fixedHeader.byteLength + tableSize
  const tableParts: Uint8Array[] = []
  for (let index = 0; index < resources.length; index++) {
    tableParts.push(unicode(resources[index]!.path), u64(resourceOffset))
    resourceOffset += resourceBodies[index]!.byteLength
  }

  return concat(fixedHeader, ...tableParts, ...resourceBodies, ascii("RSRC"))
}

export function variantNil(): Uint8Array {
  return u32(1)
}

export function variantString(value: string): Uint8Array {
  return concat(u32(5), unicode(value))
}

export function variantInternalResource(subindex: number): Uint8Array {
  return concat(u32(24), u32(2), u32(subindex))
}

export function variantUnknown(type: number): Uint8Array {
  return u32(type)
}

export function buildRscc(payload: Uint8Array, blockSize: number): Uint8Array {
  const blockCount = Math.floor(payload.byteLength / blockSize) + 1
  const compressedBlocks: Uint8Array[] = []
  for (let index = 0; index < blockCount; index++) {
    const start = index * blockSize
    const end = index === blockCount - 1 ? payload.byteLength : start + blockSize
    compressedBlocks.push(zstdCompressSync(payload.subarray(start, end)))
  }

  return concat(
    ascii("RSCC"),
    u32(2),
    u32(blockSize),
    u32(payload.byteLength),
    ...compressedBlocks.map((block) => u32(block.byteLength)),
    ...compressedBlocks,
    ascii("RSCC"),
  )
}

export function minimalShaderMaterial(code = "shader_type spatial;\n"): Uint8Array {
  return buildBinaryResource("ShaderMaterial", [
    {
      path: "local://1",
      type: "Shader",
      properties: [{ name: "code", value: variantString(code) }],
    },
    {
      path: "res://test.material",
      type: "ShaderMaterial",
      properties: [{ name: "shader", value: variantInternalResource(1) }],
    },
  ])
}

function requiredIndex(map: ReadonlyMap<string, number>, key: string): number {
  const value = map.get(key)
  if (value === undefined) {
    throw new Error(`Missing string table entry for ${key}`)
  }
  return value
}

function unicode(value: string): Uint8Array {
  const payload = Buffer.from(`${value}\0`, "utf8")
  return concat(u32(payload.byteLength), payload)
}

function ascii(value: string): Uint8Array {
  return Buffer.from(value, "ascii")
}

function u32(value: number): Uint8Array {
  const result = Buffer.alloc(4)
  result.writeUInt32LE(value)
  return result
}

function u64(value: number): Uint8Array {
  const result = Buffer.alloc(8)
  result.writeBigUInt64LE(BigInt(value))
  return result
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)))
}
