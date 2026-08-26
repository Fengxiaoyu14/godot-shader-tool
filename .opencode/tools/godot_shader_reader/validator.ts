import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { GodotReaderError } from "./errors.ts"

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface ShaderValidationSuccess {
  valid: true
  godot_version: "3.6"
  renderer: "gles3"
  shader_type: "spatial" | "canvas_item" | "particles"
}

export interface ShaderValidationFailure {
  valid: false
  godot_version: "3.6"
  renderer: "gles3"
  shader_type?: string
  error: {
    line: number
    message: string
  }
}

export type ShaderValidationResult = ShaderValidationSuccess | ShaderValidationFailure
export type ShaderValidator = (shaderCode: string) => Promise<ShaderValidationResult>

export interface ShaderValidatorOptions {
  executablePath?: string
  timeoutMs?: number
}

export function bundledValidatorPath(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if (architecture !== "x64") {
    throw new GodotReaderError(
      "SHADER_VALIDATOR_UNAVAILABLE",
      `No bundled Godot shader validator is available for architecture ${architecture}`,
    )
  }
  if (platform === "win32") {
    return fileURLToPath(new URL("../bin/windows-x64/godot-shader-validator.exe", import.meta.url))
  }
  if (platform === "linux") {
    return fileURLToPath(new URL("../bin/linux-x64/godot-shader-validator", import.meta.url))
  }
  throw new GodotReaderError(
    "SHADER_VALIDATOR_UNAVAILABLE",
    `No bundled Godot shader validator is available for platform ${platform}`,
  )
}

export async function validateGodot36Shader(
  shaderCode: string,
  options: ShaderValidatorOptions = {},
): Promise<ShaderValidationResult> {
  const executablePath = options.executablePath ?? bundledValidatorPath()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GodotReaderError("SHADER_VALIDATOR_FAILED", "Validator timeout must be a positive integer")
  }

  try {
    const executableStat = await stat(executablePath)
    if (!executableStat.isFile()) {
      throw new Error("not a regular file")
    }
  } catch (cause) {
    throw new GodotReaderError("SHADER_VALIDATOR_UNAVAILABLE", "Godot shader validator executable is unavailable", {
      details: { validator_path: executablePath },
      cause,
    })
  }

  const completed = await runValidatorProcess(executablePath, shaderCode, timeoutMs)
  if (completed.stderr.length !== 0) {
    throw invalidResponse("Validator wrote unexpected data to stderr", executablePath, completed)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(completed.stdout)
  } catch (cause) {
    throw invalidResponse("Validator stdout is not valid JSON", executablePath, completed, cause)
  }

  if (completed.exitCode === 0) {
    if (!isValidationSuccess(parsed)) {
      throw invalidResponse("Validator exit code 0 did not contain a valid success result", executablePath, completed)
    }
    return parsed
  }

  if (completed.exitCode === 1) {
    if (!isValidationFailure(parsed)) {
      throw invalidResponse("Validator exit code 1 did not contain a valid shader error", executablePath, completed)
    }
    return parsed
  }

  const internal = isRecord(parsed) && isRecord(parsed.internal_error) ? parsed.internal_error : undefined
  throw new GodotReaderError(
    "SHADER_VALIDATOR_FAILED",
    internal && typeof internal.message === "string"
      ? internal.message
      : `Godot shader validator exited with code ${completed.exitCode}`,
    {
      details: {
        validator_path: executablePath,
        exit_code: completed.exitCode,
        ...(internal && typeof internal.code === "string" ? { validator_error_code: internal.code } : {}),
        ...(completed.stderr.length === 0 ? {} : { stderr: completed.stderr }),
      },
    },
  )
}

interface CompletedProcess {
  exitCode: number
  stdout: string
  stderr: string
}

function runValidatorProcess(executablePath: string, shaderCode: string, timeoutMs: number): Promise<CompletedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let outputTooLarge = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true
        child.kill()
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true
        child.kill()
        return
      }
      stderr.push(chunk)
    })

    child.once("error", (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(new GodotReaderError(
        cause.code === "ENOENT" || cause.code === "EACCES"
          ? "SHADER_VALIDATOR_UNAVAILABLE"
          : "SHADER_VALIDATOR_FAILED",
        "Could not start the Godot shader validator",
        { details: { validator_path: executablePath }, cause },
      ))
    })

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (timedOut) {
        reject(new GodotReaderError("SHADER_VALIDATOR_TIMEOUT", "Godot shader validation timed out", {
          details: { validator_path: executablePath, timeout_ms: timeoutMs },
        }))
        return
      }
      if (outputTooLarge) {
        reject(new GodotReaderError("INVALID_VALIDATOR_RESPONSE", "Godot shader validator output exceeded 1 MiB", {
          details: { validator_path: executablePath },
        }))
        return
      }
      if (exitCode === null) {
        reject(new GodotReaderError("SHADER_VALIDATOR_FAILED", "Godot shader validator terminated by a signal", {
          details: { validator_path: executablePath, signal },
        }))
        return
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      })
    })

    child.stdin.once("error", () => undefined)
    child.stdin.end(shaderCode, "utf8")
  })
}

function isValidationSuccess(value: unknown): value is ShaderValidationSuccess {
  return isRecord(value) &&
    value.valid === true &&
    value.godot_version === "3.6" &&
    value.renderer === "gles3" &&
    (value.shader_type === "spatial" || value.shader_type === "canvas_item" || value.shader_type === "particles")
}

function isValidationFailure(value: unknown): value is ShaderValidationFailure {
  return isRecord(value) &&
    value.valid === false &&
    value.godot_version === "3.6" &&
    value.renderer === "gles3" &&
    (value.shader_type === undefined ||
      value.shader_type === "spatial" ||
      value.shader_type === "canvas_item" ||
      value.shader_type === "particles") &&
    isRecord(value.error) &&
    typeof value.error.line === "number" &&
    Number.isSafeInteger(value.error.line) &&
    value.error.line >= 1 &&
    typeof value.error.message === "string" &&
    value.error.message.length > 0
}

function invalidResponse(
  message: string,
  executablePath: string,
  completed: CompletedProcess,
  cause?: unknown,
): GodotReaderError {
  return new GodotReaderError("INVALID_VALIDATOR_RESPONSE", message, {
    details: {
      validator_path: executablePath,
      exit_code: completed.exitCode,
      stdout: completed.stdout,
      ...(completed.stderr.length === 0 ? {} : { stderr: completed.stderr }),
    },
    cause,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
