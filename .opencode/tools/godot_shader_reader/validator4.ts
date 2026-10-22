import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { GodotReaderError } from "./errors.ts"
import type { ShaderValidationResult, ShaderValidatorOptions } from "./validator.ts"

/** Official Godot 4 compiler via the headless dummy rendering backend. */
export async function validateGodot4Shader(code: string, options: ShaderValidatorOptions = {}): Promise<ShaderValidationResult> {
  const executable = options.executablePath ?? process.env.GODOT4_BIN ?? "godot4"
  const timeout = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new GodotReaderError("SHADER_VALIDATOR_FAILED", "Validator timeout must be a positive integer")
  const directory = await mkdtemp(path.join(tmpdir(), "godot4-shader-"))
  try {
    await writeFile(path.join(directory, "project.godot"), 'config_version=5\n[application]\nconfig/name="Shader validation"\n')
    await writeFile(path.join(directory, "validate.gd"), await readFile(new URL("./validate-godot4.gd", import.meta.url)))
    await writeFile(path.join(directory, "source.gdshader"), code)
    const result = await run(executable, directory, timeout)
    const complete = result.stdout.match(/^GODOT_SHADER_VALIDATION_COMPLETE:(4\.\d+)(?:\.[^\r\n]*)?$/m)
    if (!complete) throw new GodotReaderError("INVALID_VALIDATOR_RESPONSE", "Godot 4 did not complete shader compilation", { details: { stderr: result.stderr, stdout: result.stdout } })
    const version = complete[1]!
    if (Number(version.split(".")[1]) < 3) throw new GodotReaderError("UNSUPPORTED_VALIDATOR_PROFILE", "The headless compiler requires Godot 4.3 or newer")
    if (options.godotVersion && !["4", "4.x", version].includes(options.godotVersion)) {
      throw new GodotReaderError("UNSUPPORTED_VALIDATOR_PROFILE", `Requested Godot ${options.godotVersion}, executable is ${version}`)
    }
    // Diagnostics come from the official engine; no custom shader parser is used.
    const diagnostic = result.stderr.match(/SHADER ERROR:\s*([^\r\n]+)[\s\S]*?at:\s*[^\r\n]*\(:(\d+)\)/)
    const shaderType = result.stdout.match(/^GODOT_SHADER_TYPE:(spatial|canvas_item|particles|sky|fog)\r?$/m)?.[1]
    if (diagnostic) return { valid: false, godot_version: version, renderer: "dummy", shader_type: shaderType, error: { line: Math.max(1, Number(diagnostic[2])), message: diagnostic[1]! } }
    const unsupportedType = result.stderr.match(/ERROR:\s*(Shader type [^\r\n]*not supported[^\r\n]*)/)
    if (unsupportedType) return { valid: false, godot_version: version, renderer: "dummy", error: { line: 1, message: unsupportedType[1]! } }
    if (result.stderr.trim() || result.exitCode !== 0) throw new GodotReaderError("SHADER_VALIDATOR_FAILED", "Godot 4 reported a compilation or runtime error", { details: result })
    if (!code.trim()) return { valid: false, godot_version: version, renderer: "dummy", error: { line: 1, message: "Shader source is empty" } }
    if (!shaderType) throw new GodotReaderError("INVALID_VALIDATOR_RESPONSE", "Godot 4 did not report a supported shader type")
    return { valid: true, godot_version: version, renderer: "dummy", shader_type: shaderType }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function run(executable: string, directory: string, timeout: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--headless", "--path", directory, "--script", "validate.gd", "--", "source.gdshader"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GODOT_SILENCE_ROOT_WARNING: "1", APPDATA: directory, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory } })
    let stdout = "", stderr = "", timedOut = false, overflow = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8")
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) { overflow = true; child.kill() }
    }
    child.stdout.on("data", chunk => collect("stdout", chunk))
    child.stderr.on("data", chunk => collect("stderr", chunk))
    child.once("error", cause => { clearTimeout(timer); reject(new GodotReaderError("SHADER_VALIDATOR_UNAVAILABLE", "Install Godot 4 and set GODOT4_BIN to its executable path", { cause })) })
    child.once("close", exitCode => {
      clearTimeout(timer)
      if (timedOut) reject(new GodotReaderError("SHADER_VALIDATOR_TIMEOUT", "Godot 4 shader validation timed out"))
      else if (overflow) reject(new GodotReaderError("INVALID_VALIDATOR_RESPONSE", "Godot 4 output exceeded 1 MiB"))
      else resolve({ exitCode, stdout, stderr })
    })
  })
}
