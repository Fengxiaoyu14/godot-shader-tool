#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(import.meta.url)
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..")

export const RELEASE_PLATFORMS = {
  "linux-x64": {
    binaryDirectory: "linux-x64",
    binaryName: "godot-shader-validator",
  },
  "windows-x64": {
    binaryDirectory: "windows-x64",
    binaryName: "godot-shader-validator.exe",
  },
}

export async function stageReleasePackage(repositoryRoot, destination, platform) {
  const platformConfig = RELEASE_PLATFORMS[platform]
  if (platformConfig === undefined) {
    throw new Error(`Unsupported release platform: ${platform}`)
  }

  await mkdir(destination, { recursive: false })
  const packagedTools = path.join(destination, "tools")
  await cp(path.join(repositoryRoot, ".opencode/tools"), packagedTools, { recursive: true })

  const packagedBin = path.join(packagedTools, "bin")
  for (const candidate of Object.keys(RELEASE_PLATFORMS)) {
    if (candidate !== platform) {
      await rm(path.join(packagedBin, candidate), { recursive: true, force: true })
    }
  }

  await cp(path.join(repositoryRoot, "README.md"), path.join(destination, "README.md"))
  await cp(path.join(repositoryRoot, "opencode.json"), path.join(destination, "opencode.example.json"))
  await cp(path.join(repositoryRoot, "validator/LICENSE.txt"), path.join(destination, "GODOT-LICENSE.txt"))

  const forbidden = await findForbiddenTestContent(destination)
  if (forbidden.length !== 0) {
    throw new Error(`Release package contains source-only test content:\n${forbidden.join("\n")}`)
  }

  const validator = path.join(
    packagedBin,
    platformConfig.binaryDirectory,
    platformConfig.binaryName,
  )
  await readFile(validator)
  return { root: destination, tools: packagedTools, validator }
}

export async function findForbiddenTestContent(root) {
  const forbidden = []
  await walk(root, async (absolutePath, relativePath, directoryEntry) => {
    const segments = relativePath.split(path.sep)
    const base = directoryEntry.name.toLowerCase()
    if (
      segments.some((segment) => segment.toLowerCase() === "tests") ||
      base.endsWith(".test.ts") ||
      base === "fixture-builder.ts"
    ) {
      forbidden.push(relativePath.split(path.sep).join("/"))
    }
  })
  return forbidden.sort()
}

async function walk(root, visitor, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name)
    await visitor(path.join(root, relativePath), relativePath, entry)
    if (entry.isDirectory()) {
      await walk(root, visitor, relativePath)
    }
  }
}

async function buildReleasePackages(version, outputDirectory) {
  const normalizedVersion = version.startsWith("v") ? version : `v${version}`
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
    throw new Error("Version must look like v1.2.3 or 1.2.3")
  }

  await mkdir(outputDirectory, { recursive: true })
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "godot-shader-release-"))
  const checksums = []
  try {
    for (const platform of Object.keys(RELEASE_PLATFORMS)) {
      const packageName = `godot-shader-tool-${normalizedVersion}-${platform}`
      const packageRoot = path.join(temporaryRoot, packageName)
      await stageReleasePackage(defaultRepositoryRoot, packageRoot, platform)

      const archiveName = `${packageName}.zip`
      const archivePath = path.resolve(outputDirectory, archiveName)
      const completed = spawnSync(
        "python3",
        ["-m", "zipfile", "-c", archivePath, packageName],
        { cwd: temporaryRoot, encoding: "utf8" },
      )
      if (completed.status !== 0) {
        throw new Error(
          `Could not create ${archiveName}: ${completed.stderr || completed.stdout || "python3 failed"}`,
        )
      }

      const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex")
      checksums.push(`${digest}  ${archiveName}`)
      process.stdout.write(`${archivePath}\n`)
    }
    await writeFile(path.join(outputDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(scriptPath)) {
  const version = process.argv[2]
  if (version === undefined || process.argv.length > 4) {
    process.stderr.write("Usage: node scripts/release-package.mjs <version> [output-directory]\n")
    process.exitCode = 2
  } else {
    const outputDirectory = path.resolve(process.argv[3] ?? path.join(defaultRepositoryRoot, "dist"))
    buildReleasePackages(version, outputDirectory).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
