# Godot 3.6 Shader Validate/Read/Write Tools for OpenCode

This repository provides three OpenCode custom tools for Godot **3.6** binary
`ShaderMaterial` resources:

- `godot-shader-validate` validates source directly or extracts it from a
  `.material`/`.res` through the shared binary codec.
- `godot-shader-read` reads the complete embedded `Shader.code`.
- `godot-shader-write` replaces the complete `Shader.code` only after mandatory
  validation before serialization and again from the actual temp-file read-back.

Validation uses the official Godot `ShaderLanguage` and `ShaderTypes` sources at
`3.6-stable` commit
[`de2f0f147c5b7eff2d0f6dbc35042a4173fd59be`](https://github.com/godotengine/godot/tree/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be).
The validator is fixed to GLES3 (`low_end=false`). It does not start Godot,
load a project, open a window, create an OpenGL context, or access a GPU. There
is no custom parser, regex validator, `glslang`, or selectable backend.

## Install

Global installation is recommended so the tools are available in every
worktree. From this repository's root, copy the complete tools directory.

macOS/Linux:

```bash
mkdir -p ~/.config/opencode/tools
cp -R .opencode/tools/. ~/.config/opencode/tools/
```

Windows PowerShell:

```powershell
$target = "$HOME\.config\opencode\tools"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item ".\.opencode\tools\*" $target -Recurse -Force
```

Restart OpenCode after copying. The important installed paths are:

```text
tools/
├── godot-shader-read.ts
├── godot-shader-validate.ts
├── godot-shader-write.ts
├── bin/
│   ├── linux-x64/godot-shader-validator
│   └── windows-x64/godot-shader-validator.exe
└── godot_shader_reader/
    ├── codec.ts
    ├── file-writer.ts
    ├── validation-tool.ts
    ├── validator.ts
    └── ...
```

The executable path is resolved relative to `validator.ts`, never from the
current working directory. Linux x64 and Windows x64 are bundled. Unsupported
platforms or architectures fail closed.

Configure reads and validation as automatic, while keeping writes behind a
confirmation prompt:

```json
{
  "permission": {
    "godot-shader-read": "allow",
    "godot-shader-validate": "allow",
    "godot-shader-write": "ask"
  }
}
```

For project-only installation, copy `.opencode` and `opencode.json` into that
project's root. OpenCode supplies `@opencode-ai/plugin` and Bun. RSCC/ZSTD input
uses `Bun.zstdDecompressSync`; RSCC output uses `Bun.zstdCompressSync`.

## Use

Validate a complete source string:

```text
godot-shader-validate({
  shader_code: "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(1.0); }"
})
```

Or validate the Shader embedded in a binary material:

```text
godot-shader-validate({
  path: "/absolute/path/to/example.material"
})
```

Exactly one of `shader_code` or `path` is required. A valid response is:

```json
{
  "valid": true,
  "godot_version": "3.6",
  "renderer": "gles3",
  "shader_type": "spatial"
}
```

An ordinary shader error is data, not a tool crash:

```json
{
  "valid": false,
  "godot_version": "3.6",
  "renderer": "gles3",
  "shader_type": "spatial",
  "error": {
    "line": 2,
    "message": "Unknown identifier in expression: missing_value"
  }
}
```

Read and replace complete Shader source with:

```text
godot-shader-read({
  path: "/absolute/path/to/example.material"
})

godot-shader-write({
  path: "/absolute/path/to/example.material",
  shader_code: "shader_type spatial;\n..."
})
```

Absolute paths are recommended for temporary OpenCode worktrees. Relative paths
resolve from `context.worktree`. Source is stored exactly; the writer does not
trim, format, or normalize LF/CRLF.

A successful write returns compact metadata:

```json
{
  "success": true,
  "path": "/absolute/path/to/example.material",
  "resource_type": "ShaderMaterial",
  "validation": {
    "pre_write_shader": true,
    "resource_read_back": true,
    "shader_code_match": true,
    "semantic_diff": true,
    "post_write_shader": true
  },
  "before": { "shader_length": 1401 },
  "after": { "shader_length": 1732 }
}
```

## Write safety

Every write follows this order:

```text
officially validate requested Shader
→ read and parse the complete original resource
→ replace only the existing Shader.code in the typed IR
→ fully serialize headers, tables, resources, and RSCC blocks
→ write and fsync a unique sibling temp file
→ parse the actual temp bytes through the shared reader
→ require exact Shader.code equality
→ semantic-diff every resource/property except Shader.code
→ officially validate Shader.code extracted from that read-back
→ verify the original bytes did not change concurrently
→ safely replace the original
```

Missing executable, startup failure, timeout, malformed JSON, nonstandard exit,
invalid shader, serialization failure, read-back failure, mismatch, or semantic
change all stop before replacement. The original remains unchanged. POSIX uses a
same-directory atomic rename. Windows uses a recoverable two-stage rename and
restores the original if the destination step fails.

Only the located `Shader.code` String Variant may differ. Resource versions,
container strategy, external resources, internal paths/order/types, property
names/order, object references, Shader parameters, and all other Variant values
must remain equal.

## Standalone validator CLI

The native CLI accepts stdin or a shader file and writes one JSON object to
stdout. Diagnostics never share stdout.

```bash
printf '%s' 'shader_type spatial;' |
  .opencode/tools/bin/linux-x64/godot-shader-validator --stdin

.opencode/tools/bin/linux-x64/godot-shader-validator \
  --file validator/tests/shaders/valid-spatial.gdshader
```

Exit codes are `0` for valid, `1` for a shader error, `2` for an internal
validator failure, and `3` for invalid/unreadable input.

## Build the validator

The build scripts pin and verify Godot's exact commit, apply the standalone
patch, build a sectioned Core archive, link only the needed sections, and copy
artifacts to their stable module-relative locations.

Required host commands are Git, Python/SCons, CMake, Ninja, a Linux C++ compiler,
binutils, Node.js, and a POSIX MinGW-w64 x86-64 toolchain. MinGW must provide the
`x86_64-w64-mingw32-*` compiler, binutils, `gcc-ar`, `gcc-ranlib`, and `windres`
commands.

```bash
# Optional: reuse an already checked-out exact Godot tree.
export GODOT_SOURCE_DIR=/absolute/path/to/godot-3.6

# Default VALIDATOR_JOBS is 1 for reliable static-archive creation.
validator/scripts/build-all.sh
```

Individual commands are also available:

```bash
validator/scripts/build-native.sh
validator/scripts/test-native.sh
validator/scripts/build-windows-x64.sh
validator/scripts/inspect-windows.sh
```

The Windows executable is statically linked with libgcc/libstdc++. PE inspection
allows only `KERNEL32.dll` and `msvcrt.dll`; it rejects Godot, OpenGL, or other
runtime DLL imports. See
[`validator/README_GODOT_PATCHES.md`](validator/README_GODOT_PATCHES.md) for the
nine-call GLES3 adaptation, minimal initialization analysis, stubs, and license.

Current artifact hashes are recorded in
[`validator/SHA256SUMS`](validator/SHA256SUMS). Godot's MIT license is retained in
[`validator/LICENSE.txt`](validator/LICENSE.txt).

## Shared IR and supported writes

The reader parses all internal resources into one typed model. The public codec
flow is:

```typescript
const parsed = parseResource(bytes)
const code = getShaderCode(parsed.resource)
setShaderCode(parsed.resource, replacement)
const output = serializeResource(parsed)
```

The original offsets remain diagnostic data only. Serialization reserves and
patches a new internal-resource offset table from actual writer positions.

The writer supports every non-deprecated Variant supported by the reader:

- Nil, Bool, Int, Int64, Real, Double, and String;
- Vector2, Rect2, Vector3, Plane, Quat, AABB, Basis, Transform, Transform2D,
  and Color;
- NodePath and RID;
- empty, internal, indexed external, and legacy inline external Object refs;
- Dictionary and Array;
- all Godot 3.x Pool array types.

Unknown types fail with `UNSUPPORTED_VARIANT_FOR_WRITE`; they are never guessed,
zeroed, skipped, or retained as opaque byte spans.

## Test

Run the complete Node.js 24+ suite:

```bash
node --experimental-strip-types --test \
  .opencode/tools/godot_shader_reader/tests/*.test.ts
```

It covers the codec and every supported Variant; official syntax, unknown-name,
built-in, render-mode, `uint/uvec`, array, and `switch` validation; direct/path
validation; validator unavailable/bad-JSON/timeout/internal failures; pre/post
write validation and unchanged originals; Windows restore behavior; and an
OpenCode validate→write→read wrapper E2E flow.

Run the standalone CLI fixture matrix separately with:

```bash
validator/scripts/test-native.sh
```

To add a private real Godot 3.6 material as a Golden Sample:

```bash
GODOT_SHADER_GOLDEN=/absolute/path/to/example.material \
node --experimental-strip-types --test \
  .opencode/tools/godot_shader_reader/tests/golden-material.test.ts
```

The Golden test validates the original source, performs valid no-op/shorter/
longer/Unicode/multi-block writes, and verifies that syntax and identifier
errors preserve the original bytes. Private material content is never committed.

## Current limits

- Exactly Godot 3.6 (`version_major=3`, `version_minor=6`, binary
  `format_version=3`) and GLES3 shader semantics.
- Little-endian resources only.
- RSCC compression mode `2` (ZSTD) and uncompressed RSRC only.
- Writer requires `import_metadata_offset == 0`; import metadata payloads are not
  modeled.
- Root resource must already be `ShaderMaterial`; `shader` must reference an
  internal `Shader`; `code` must already be a non-empty String Variant.
- Deprecated embedded Image and InputEvent Variants are unsupported.
- No Godot 4.x, scene recursion, texture decoding, partial text patches, new
  resources, or resource/property insertion/deletion.
- Bundled validator executables currently cover x64 Linux and x64 Windows.

See [`docs/GODOT-3.6-FORMAT.md`](docs/GODOT-3.6-FORMAT.md) for binary layout and
official Loader/Saver mapping, and
[`docs/WRITER-VALIDATION.md`](docs/WRITER-VALIDATION.md) for the recorded test,
native runtime, and PE inspection results.
