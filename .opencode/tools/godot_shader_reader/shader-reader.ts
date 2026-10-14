import { parseResource, type ParsedResource } from "./codec.ts"
import { extractShaderCode } from "./resource.ts"
import type { ContainerMetadata, ZstdDecoder } from "./rscc.ts"
import { materialParams } from "./material-params.ts"
import { shaderHash } from "./source-info.ts"

export interface ShaderReadResult {
  params?: ReturnType<typeof materialParams>
  container: ContainerMetadata
  resource: {
    type: string
    version_major: number
    version_minor: number
    format_version: number
    big_endian: boolean
    use_real64: boolean
    external_resources: Array<{ type: string; path: string }>
    internal_resources: Array<{ path: string; offset: number }>
  }
  shader: {
    subindex: number
    internal_resource_index: number
    code: string
    length: number
    hash: string
  }
}

export function readGodot36Shader(bytes: Uint8Array, zstdDecoder?: ZstdDecoder): ShaderReadResult {
  return readEmbeddedShader(parseResource(bytes, zstdDecoder))
}

export function readEmbeddedShader(parsed: ParsedResource): ShaderReadResult {
  const model = parsed.resource
  const extracted = extractShaderCode(model)

  return {
    params: materialParams(model),
    container: parsed.container,
    resource: {
      type: model.type,
      version_major: model.versionMajor,
      version_minor: model.versionMinor,
      format_version: model.formatVersion,
      big_endian: model.bigEndian,
      use_real64: model.useReal64,
      external_resources: model.externalResources,
      internal_resources: model.internalResources,
    },
    shader: {
      subindex: extracted.shaderSubindex,
      internal_resource_index: extracted.shaderResource.index,
      code: extracted.code,
      length: extracted.code.length,
      hash: shaderHash(extracted.code),
    },
  }
}
