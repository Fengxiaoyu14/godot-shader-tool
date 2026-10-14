import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

import { parseResource } from "./codec.ts"
import { GodotReaderError } from "./errors.ts"
import { getMaterialShaderReference, type BinaryResourceModel } from "./resource.ts"
import { readEmbeddedShader, type ShaderReadResult } from "./shader-reader.ts"
import type { ZstdDecoder } from "./rscc.ts"
import { decodeShaderUtf8, readTextShader } from "./text-shader.ts"
import { materialParams, resourceHash } from "./material-params.ts"
import { shaderHash } from "./source-info.ts"

export interface ShaderFileReadOptions {
  params?: boolean
  projectRoot?: string
  shaderPath?: string
  zstdDecoder?: ZstdDecoder
}

export interface ShaderFileReadResult {
  path: string
  resource_hash?: string
  params?: ReturnType<typeof materialParams>
  container: ShaderReadResult["container"] | { format: "text" | "source"; uncompressed_size: number }
  resource: ShaderReadResult["resource"] | { type: "Shader"; format_version?: number }
  shader: {
    source: "embedded" | "external" | "standalone"
    path: string
    code: string
    length: number
    hash: string
    subindex?: number
    internal_resource_index?: number
    resource_path?: string
    external_resource_index?: number
    project_root?: string
    overridden?: boolean
  }
}

/** File-aware reader. The byte-only codec remains deterministic and performs no IO. */
export async function readGodotShaderFile(
  inputPath: string,
  options: ShaderFileReadOptions = {},
): Promise<ShaderFileReadResult> {
  const input = await readRegularFile(path.resolve(inputPath), false)
  const parsed = isBinary(input.bytes) ? parseResource(input.bytes, options.zstdDecoder) : undefined
  if (parsed?.resource.type === "ShaderMaterial") {
    const extra = options.params === false ? {} : { resource_hash: resourceHash(input.bytes), params: materialParams(parsed.resource) }
    const { reference } = getMaterialShaderReference(parsed.resource)
    if (reference.kind === "internal") {
      rejectUnusedOverride(options)
      const { params: embeddedParams, ...result } = readEmbeddedShader(parsed)
      return { path: input.path, ...result, ...extra, shader: { ...result.shader, source: "embedded", path: input.path } }
    }
    const details: Record<string, unknown> = { material_path: input.path, dependency_path: reference.path }
    try {
      const resolved = await resolveDependency(reference.path, input.path, options)
      details.resolved_path = normalized(resolved.path)
      if (resolved.projectRoot) details.project_root = normalized(resolved.projectRoot)
      const dependency = await readRegularFile(resolved.path, true)
      const shader = readStandaloneShader(dependency.bytes, dependency.path, options.zstdDecoder)
      return {
        path: input.path,
        ...extra,
        ...(options.params === false ? {} : { params: materialParams(parsed.resource, shader.code) }),
        container: parsed.container,
        resource: describeBinaryResource(parsed.resource),
        shader: {
          source: "external", path: dependency.path,
          resource_path: reference.path,
          ...(reference.index === undefined ? {} : { external_resource_index: reference.index }),
          ...(resolved.projectRoot ? { project_root: normalized(resolved.projectRoot) } : {}),
          overridden: options.shaderPath !== undefined,
          code: shader.code, length: shader.code.length, hash: shaderHash(shader.code),
        },
      }
    } catch (error) {
      if (!(error instanceof GodotReaderError)) throw error
      throw new GodotReaderError(error.code, error.message, {
        line: error.line, offset: error.offset, cause: error,
        details: { ...error.details, ...details },
      })
    }
  }
  rejectUnusedOverride(options)
  const shader = readStandaloneShader(input.bytes, input.path, options.zstdDecoder, parsed?.resource)
  return {
    path: input.path,
    container: parsed?.container ?? { format: shader.format, uncompressed_size: input.bytes.byteLength },
    resource: parsed ? describeBinaryResource(parsed.resource) : {
      type: "Shader", ...(shader.format === "text" ? { format_version: 2 } : {}),
    },
    shader: { source: "standalone", path: input.path, code: shader.code, length: shader.code.length, hash: shaderHash(shader.code) },
  }
}

function readStandaloneShader(bytes: Uint8Array, filePath: string, decoder?: ZstdDecoder, model?: BinaryResourceModel): {
  code: string; format: "text" | "source"
} {
  if (isBinary(bytes)) {
    const resource = model ?? parseResource(bytes, decoder).resource
    const root = resource.parsedInternalResources.at(-1)
    if (resource.type !== "Shader" || root?.type !== "Shader") {
      throw new GodotReaderError("NOT_SHADER_RESOURCE", "Expected a standalone Shader resource", {
        details: { resource_type: resource.type },
      })
    }
    const property = root.properties.find((p) => p.name === "code")
    if (!property) throw new GodotReaderError("SHADER_CODE_NOT_FOUND", "Shader has no code property")
    if (property.value.type !== "string" || typeof property.value.value !== "string") {
      throw new GodotReaderError("SHADER_CODE_NOT_STRING", "Shader.code must be a String", { offset: property.offset })
    }
    requireCode(property.value.value)
    return { code: property.value.value, format: "text" }
  }
  const text = decodeShaderUtf8(bytes)
  if ([".shader", ".gdshader"].includes(path.extname(filePath).toLowerCase())) {
    requireCode(text)
    return { code: text, format: "source" }
  }
  return { code: readTextShader(text), format: "text" }
}

function requireCode(code: string): void {
  if (code.length === 0) throw new GodotReaderError("SHADER_CODE_NOT_FOUND", "Shader source is empty")
}

function rejectUnusedOverride(options: ShaderFileReadOptions): void {
  if (options.shaderPath !== undefined) {
    throw new GodotReaderError("INVALID_READ_ARGUMENTS", "shader_path is only valid for a material with an external Shader")
  }
}

async function resolveDependency(reference: string, materialPath: string, options: ShaderFileReadOptions): Promise<{
  path: string; projectRoot?: string
}> {
  if (options.shaderPath !== undefined) return { path: path.resolve(options.shaderPath) }
  if (reference.startsWith("res://")) {
    const root = options.projectRoot === undefined
      ? await findProjectRoot(path.dirname(materialPath))
      : path.resolve(options.projectRoot)
    if (!root || !(await isDirectory(root))) {
      throw new GodotReaderError("PROJECT_ROOT_NOT_FOUND", "Cannot resolve res:// Shader; supply project_root or shader_path", {
        details: { searched_from: path.dirname(materialPath), project_root: root },
      })
    }
    return { path: path.resolve(root, reference.slice(6)), projectRoot: root }
  }
  if (reference.length === 0 || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(reference)) {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_PATH", `Cannot resolve Shader path ${reference}; supply shader_path`)
  }
  // Windows absolute resource paths cannot be interpreted on a POSIX host.
  if (path.win32.isAbsolute(reference) && !path.isAbsolute(reference)) {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_PATH", "Shader path belongs to another OS; supply shader_path")
  }
  return { path: path.resolve(path.dirname(materialPath), reference) }
}

async function findProjectRoot(directory: string): Promise<string | undefined> {
  for (;;) {
    try {
      if ((await stat(path.join(directory, "project.godot"))).isFile()) return directory
    } catch (cause) {
      if (!isMissing(cause)) throw new GodotReaderError("FILE_READ_FAILED", "Cannot inspect project.godot", {
        cause, details: { path: path.join(directory, "project.godot") },
      })
    }
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory()
  } catch (cause) {
    if (isMissing(cause)) return false
    throw new GodotReaderError("FILE_READ_FAILED", "Cannot inspect project_root", { cause, details: { path: directory } })
  }
}

async function readRegularFile(requested: string, dependency: boolean): Promise<{ path: string; bytes: Uint8Array }> {
  try {
    const resolved = await realpath(requested)
    if (!(await stat(resolved)).isFile()) {
      throw new GodotReaderError(dependency ? "DEPENDENCY_NOT_FOUND" : "FILE_NOT_FOUND", `Not a regular file: ${requested}`, {
        details: { path: normalized(requested) },
      })
    }
    return { path: normalized(resolved), bytes: await readFile(resolved) }
  } catch (cause) {
    if (cause instanceof GodotReaderError) throw cause
    const missing = isMissing(cause)
    throw new GodotReaderError(
      dependency ? (missing ? "DEPENDENCY_NOT_FOUND" : "DEPENDENCY_READ_FAILED") : (missing ? "FILE_NOT_FOUND" : "FILE_READ_FAILED"),
      `${missing ? "File not found" : "Cannot read file"}: ${requested}`,
      { cause, details: { path: normalized(requested) } },
    )
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))
}

function normalized(value: string): string {
  return value.split(path.sep).join("/")
}

function isBinary(bytes: Uint8Array): boolean {
  const magic = String.fromCharCode(...bytes.subarray(0, 4))
  return magic === "RSCC" || magic === "RSRC"
}

function describeBinaryResource(model: BinaryResourceModel): ShaderReadResult["resource"] {
  return {
    type: model.type, version_major: model.versionMajor, version_minor: model.versionMinor,
    format_version: model.formatVersion, big_endian: model.bigEndian, use_real64: model.useReal64,
    external_resources: model.externalResources, internal_resources: model.internalResources,
  }
}
