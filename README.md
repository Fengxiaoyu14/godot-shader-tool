# Godot 3.5/3.6 Shader Validate/Read/Write Tools for OpenCode

This repository provides three OpenCode custom tools for Godot **3.5/3.6** binary
`ShaderMaterial` resources and standalone Shader reads:

- `godot-shader-validate` validates source directly or extracts it from a
  material or standalone Shader file through the shared reader, including external references.
- `godot-shader-read` reads complete embedded or external `Shader.code`.
  It also accepts standalone binary/text Shader resources and `.shader`/`.gdshader` source.
- `godot-shader-write` replaces embedded or external `Shader.code` only after mandatory
  validation before serialization and again from the actual temp-file read-back.

Validation uses the official Godot `ShaderLanguage` and `ShaderTypes` sources at
`3.6-stable` commit
[`de2f0f147c5b7eff2d0f6dbc35042a4173fd59be`](https://github.com/godotengine/godot/tree/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be).
The validator is fixed to GLES3 (`low_end=false`). It does not start Godot,
load a project, open a window, create an OpenGL context, or access a GPU. Shader-language validation has no custom parser, regex validator, `glslang`,
or selectable backend. A separate resource-text reader decodes `.tres` strings;
it does not validate shader-language syntax.

## Install

Global installation is recommended so the tools are available in every
worktree. The `.opencode/tools` directory contains runtime files only, so it
can be copied directly from a source checkout.

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

GitHub Release archives are platform-specific and use the same installable
`tools/` layout. After extracting an archive, copy its complete `tools`
directory to `~/.config/opencode/tools`. Release archives intentionally omit
the source-only test suite, fixtures, native sources, and build scripts.

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

### External Shader references

A binary material may reference `res://shaders/shared.tres` instead of embedding
its Shader. `read` and path-based `validate` follow indexed and legacy inline
external references. The external file must contain a standalone Shader, not
another ShaderMaterial. Texture dependencies are not opened.

For `res://`, the reader walks up from the material's actual filesystem directory
and uses the nearest `project.godot`. This does not depend on OpenCode's worktree.
An explicit `project_root` takes precedence and can be used for an extracted
project tree without `project.godot`:

```text
godot-shader-read({
  path: "D:/work/project/materials/example.material",
  project_root: "D:/work/project"
})
```

If the dependency was uploaded separately or renamed, supply it explicitly:

```text
godot-shader-read({
  path: "D:/samples/example.material",
  shader_path: "D:/samples/uploaded-shader.tres"
})
```

`shader_path` takes precedence over the stored external reference and project
root. It is rejected for embedded/standalone inputs so it cannot silently select
the wrong source. The same options work with `godot-shader-validate({ path, ... })` and
`godot-shader-write({ path, shader_code, ... })`;
they are not accepted with direct `shader_code` validation. All relative tool
arguments resolve from `context.worktree`; relative references stored inside a
material resolve from the material directory. Absolute local references work,
while `user://`, network URLs, and foreign-OS absolute paths require an override.
The reader never searches by filename or guesses a project from a stored asset path.

Successful file reads add `shader.source` (`embedded`, `external`, or `standalone`)
and `shader.path`. External reads also return the original `resource_path`, an
`external_resource_index` when present, the resolved `project_root` when used,
and `overridden`. Existing embedded `subindex` and `internal_resource_index`
fields remain unchanged; external reads do not invent these fields.

Standalone `.tres` inputs must be `[gd_resource type="Shader" format=2]` with a
non-empty String `code` in `[resource]`. Text format 2 identifies the Godot 3
format, not its exact minor version. The reader handles multiline strings,
escaped quotes/backslashes, Unicode, BOM, comments, and nested metadata; it
preserves decoded source including LF/CRLF. Binary Shader files are recognized
by RSCC/RSRC magic regardless of extension. `.shader`/`.gdshader` files are read
as UTF-8 source; shader syntax is checked only by `validate`.

| Error | Meaning / action |
|---|---|
| `PROJECT_ROOT_NOT_FOUND` | `res://` needs `project_root` or `shader_path`. |
| `DEPENDENCY_NOT_FOUND` | Referenced Shader is absent or not a regular file; inspect `dependency_path` and `resolved_path`. |
| `DEPENDENCY_READ_FAILED` | Dependency exists but could not be read. |
| `NOT_SHADER_RESOURCE` | Reference or external file has the wrong resource type. |
| `INVALID_TEXT_RESOURCE` / `INVALID_UTF8` | External text is malformed; inspect file provenance and line details. |
| `EXTERNAL_SHADER_REQUIRES_FILE` | Byte-only codec cannot resolve files; use `readGodotShaderFile`. |
| `EXTERNAL_SHADER_WRITE_UNSUPPORTED` | Byte-only rewrite cannot follow an external file; use `writeGodotShaderFile`. |

The synchronous `readGodot36Shader(bytes)` API reads embedded or standalone binary
Shaders and performs no filesystem IO. Its existing name is retained for compatibility. The async `readGodotShaderFile(path, { projectRoot?, shaderPath?,
zstdDecoder? })` adds file-aware reads; relative options for this standalone API
are based on the process working directory. Neither reading nor validation
rewrites the material, dependency, or line endings.

### Writing external or standalone Shaders

```text
godot-shader-write({
  path: "D:/work/project/materials/example.material",
  shader_code: "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(0.5); }",
  project_root: "D:/work/project"
})
```

When the material references an external Shader, the actual Shader file is
modified and the material bytes are preserved. Every material sharing that
Shader will see the change. The result returns `path` (requested input),
`written_path` (actual modified file), `source`, and `shared_shader: true` for
external writes. `shader_path` explicitly selects an external target when the
original dependency is unavailable or renamed. A standalone `.tres`, binary
Shader, `.shader`, or `.gdshader` may also be passed directly as `path`.

Text writes replace only the root `code` String token, preserving the header,
comments, metadata, BOM and all text outside that token exactly. Escaping inside
the token may be reserialized; decoded Shader source stays exact. Raw source
writes preserve an existing UTF-8 BOM. Binary writes preserve the original
engine major/minor, format version, resource metadata, and compression mode.
The writer rechecks both the shared Shader and referring material before
replacement, aborting on concurrent edits or a changed dependency target.

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
→ resolve the actual Shader file and snapshot input/target
→ replace only existing Shader.code (typed binary IR or text String token)
→ serialize the target while preserving non-code content
→ write and fsync a unique sibling temp file
→ parse the actual temp bytes through the shared reader
→ require exact Shader.code equality
→ compare all non-code content (semantic binary diff or exact text prefix/suffix)
→ officially validate Shader.code extracted from that read-back
→ verify input, target bytes, and reference resolution did not change concurrently
→ safely replace the original
```

Missing executable, startup failure, timeout, malformed JSON, nonstandard exit,
invalid shader, serialization failure, read-back failure, mismatch, or semantic
change all stop before replacement. The original remains unchanged. POSIX uses a
same-directory atomic rename. Windows uses a recoverable two-stage rename and
restores the original if the destination step fails.

For binary writes, only the located `Shader.code` String Variant may differ. Resource versions,
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

## Build release packages

From a complete source checkout, build the Linux x64 and Windows x64
installation archives with:

```bash
node scripts/release-package.mjs v1.2.0
```

The archives and their `SHA256SUMS` file are written to `dist/`. Each archive
contains only one platform's validator, the runtime `tools/` tree, the README,
an OpenCode configuration example, and Godot's license. Packaging fails if any
`tests/`, `*.test.ts`, or fixture-builder content enters the staged artifact.

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
  tests/godot_shader_reader/*.test.ts
```

It covers the codec and every supported Variant; official syntax, unknown-name,
built-in, render-mode, `uint/uvec`, array, and `switch` validation; direct/path
validation; validator unavailable/bad-JSON/timeout/internal failures; pre/post
write validation and unchanged originals; Windows restore behavior; and an
OpenCode validate→write→read wrapper E2E flow.

Tests are source-checkout-only and are not installed under
`~/.config/opencode/tools`. The release-package smoke test stages the same
runtime layout shipped to users, confirms that it contains no test content, and
runs embedded and external validate→write→read
checks from that staged directory. Synthetic external fixtures cover root discovery,
explicit overrides, text decoding, missing dependencies, wrong types, corrupt input,
and unchanged originals. Private material and Shader files are not committed.

Run the standalone CLI fixture matrix separately with:

```bash
validator/scripts/test-native.sh
```

To add a private real Godot 3.6 material as a Golden Sample:

```bash
GODOT_SHADER_GOLDEN=/absolute/path/to/example.material \
node --experimental-strip-types --test \
  tests/godot_shader_reader/golden-material.test.ts
```

The Golden test validates the original source, performs valid no-op/shorter/
longer/Unicode/multi-block writes, and verifies that syntax and identifier
errors preserve the original bytes. Private material content is never committed.

## Current limits

- Binary files: Godot 3.5/3.6 (`version_major=3`, `version_minor=5` or `6`,
  `format_version=3`). Other engine or binary format versions remain rejected.
- Shader validation still uses the bundled Godot 3.6 GLES3 compiler; supporting
  3.5 file headers does not claim full Godot 3.5 shader-language validation.
- Little-endian resources only.
- RSCC compression mode `2` (ZSTD) and uncompressed RSRC only.
- Writer requires `import_metadata_offset == 0`; import metadata payloads are not
  modeled.
- Material root must already be `ShaderMaterial`; `shader` must reference an
  internal or external `Shader`. Standalone roots must be `Shader`; existing
  `code` must be a non-empty String. No resource creation is supported.
- Deprecated embedded Image and InputEvent Variants are unsupported.
- Text ShaderMaterial loading and recursive material references are not supported.
- No Godot 4.x resource format, scene recursion, texture decoding, partial text patches, new
  resources, or resource/property insertion/deletion.
- Bundled validator executables currently cover x64 Linux and x64 Windows.

See [`docs/GODOT-3.6-FORMAT.md`](docs/GODOT-3.6-FORMAT.md) for binary layout and
official Loader/Saver mapping, and
[`docs/WRITER-VALIDATION.md`](docs/WRITER-VALIDATION.md) for the recorded test,
native runtime, and PE inspection results.
