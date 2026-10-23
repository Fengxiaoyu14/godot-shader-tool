# Godot 3.5/3.6 and 4.x Shader Validate/Read/Write Tools for OpenCode

Current release: **v1.3.0** — guarded patches, batch plans and source inspection.

Godot **4.x read, write and validate** are now supported on main. See
[Godot 4 support and setup](docs/GODOT-4-SUPPORT.md) for the supported formats,
examples and verification. Godot 4 validation requires an installed official
Godot **4.3+** engine (`GODOT4_BIN`); **4.5.1** is the tested reference. It uses
the official headless dummy compiler, without a GPU. Resource files select the
compiler major automatically; for raw `.gdshader` or direct source, select
`godot_version: "4.x"`. Godot 3 keeps its bundled 3.6 GLES3 compiler.

The reference below describes the original **Godot 3.5/3.6** workflow. Godot 4
format and compiler differences are documented in the linked support guide.


This repository provides OpenCode custom tools for Godot **3.5/3.6** binary
`ShaderMaterial` resources and standalone Shader reads:

- `godot-shader-validate` validates source directly or extracts it from a
  material or standalone Shader file through the shared reader, including external references.
- `godot-shader-read` reads complete embedded or external `Shader.code`.
  It also accepts standalone binary/text Shader resources and `.shader`/`.gdshader` source.
- `godot-shader-write` replaces embedded or external `Shader.code` only after mandatory
  validation before serialization and again from the actual temp-file read-back.
- `godot-shader-write-patch` applies count-asserted literal edits internally and returns a diff.
- `godot-shader-write-plan` executes a JSON plan with independent per-file transactions.
- `godot-shader-search` searches decoded source recursively and returns lines and SHA-256 hashes.

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
    "godot-shader-write": "ask",
    "godot-shader-write-patch": "ask",
    "godot-shader-write-plan": "ask",
    "godot-shader-search": "allow"
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

## Patches and batch plans

Patch existing decoded source without routing the full Shader through an LLM:

```text
godot-shader-write-patch({
  path: "materials/car.material",
  ops: [
    {find: "vec4 light;", replace: "vec4 light = vec4(0.);", expect: 1}
  ]
})
```

`find` and `replace` are literal strings, including `$&`, backslashes and line
endings. `expect` is a required positive integer counting non-overlapping
matches. Operations run in order on the result of the previous operation, in
memory. A missing/excess match or malformed operation rejects the entire file;
none of its edits reach disk. Empty finds and unknown fields are rejected.
Use `replace: ""` for guarded text deletion.

Line deletion is also available, with an exact-content guard:

```json
{"delete_lines": [282, 283], "expected_text": "// first line\n// second line\n", "expect": 1}
```

The range is 1-based and inclusive in the **current intermediate source**.
`expected_text` must equal those complete lines, including their LF/CRLF endings;
`expect` must be 1. Bare line-number deletion is rejected to prevent shifted
line numbers from silently deleting the wrong code.

Both full writes and patches accept `expected_hash` (full decoded-source SHA-256)
and `dry_run: true`. Dry runs still serialize a sibling temporary file, verify
its actual read-back, and run official pre/post validation, but never replace
the original. Results include `before.shader_hash`, `after.shader_hash`,
`expected_diff` (unified diff with three context lines), and `dry_run`.
An unchanged source returns an empty diff. Diffs describe source, not binary
container bytes; they are also returned by full-source writes.

For a batch, save a JSON array such as `plans/fresnel.json`:

```json
[
  {
    "path": "../materials/car-a.material",
    "ops": [{"find": "vec4 light;", "replace": "vec4 light = vec4(0.);", "expect": 1}]
  },
  {
    "path": "../materials/car-b.material",
    "ops": [{"find": "vec4 light;", "replace": "vec4 light = vec4(0.);", "expect": 1}]
  }
]
```

```text
godot-shader-write-plan({plan_path: "plans/fresnel.json", dry_run: true})
godot-shader-write-plan({plan_path: "plans/fresnel.json"})
```

Only `plan_path` is resolved from the OpenCode worktree. Paths **inside** the
plan (`path`, optional `project_root` and `shader_path`) resolve from the plan's
directory. An entry may also supply `expected_hash`; use hashes recorded during
review to detect changes between review and execution. Without it, the batch
freezes each source hash during preflight, protecting the execution itself.
Dry run and apply are separate calls; dry run does not silently modify the plan
or bind a later approval to its contents.

The plan is read once. All actual Shader targets are resolved before writes.
If multiple entries resolve to the same target (including a shared external
Shader), **all colliding entries are rejected** with `DUPLICATE_WRITE_TARGET`.
Keep one entry for that shared target. Distinct files containing identical
embedded source are processed independently. The writer rechecks the target,
source and referring material against concurrent edits before replacement.

One `godot-shader-write-plan` invocation uses one OpenCode tool permission;
it does not invoke a separate ask-gated tool for every entry. Approving the plan
includes the actual external Shader files it resolves to. Configure this tool
as `ask` and review its targets/dry-run output. Ordinary single-file write and
patch calls keep their own permissions.

The response contains `summary` and a `results` entry for every input, including
hashes/diffs for successful writes and diagnostic errors for failures:

| Status | Meaning |
|---|---|
| `success` | This file was replaced after mandatory validation. |
| `dry_run` | Validation succeeded; original was not replaced. |
| `rejected` | Preflight rejected the entry; no write attempted. |
| `failed_original_preserved` | Failed before replacement; this operation preserved the original. |
| `failed_check_required` | Concurrent edit, uncertain OS replacement failure, or unexpected internal error; inspect diagnostics. |

Failures do not stop later entries, and earlier successes are not rolled back.
This is a per-file transaction, not an all-plan transaction. Validation failure
normally discards a temp file before replacement, so reporting it as a completed
write followed by a rollback would be inaccurate. A Windows restore failure
still exposes the existing `recoverable_backup_path` diagnostic.

## Hashes, selective reads and search

Every file read and byte-only `readGodot36Shader` result includes `shader.hash`:
lowercase SHA-256 of decoded source encoded as UTF-8. It excludes resource
serialization, the resource String terminator and a source-file BOM. It
**includes** comments, whitespace and exact LF/CRLF. Same hashes group exact
code copies; they do not prove equal material uniforms or rendering behavior.

```text
godot-shader-read({path: "car.material", metadata_only: true})
godot-shader-read({path: "car.material", start_line: 280, end_line: 320})
godot-shader-search({pattern: "fresnel", project_root: "."})
godot-shader-search({pattern: "pow\\s*\\(", project_root: ".", regex: true, max_matches: 100, offset: 0})
```

`metadata_only` omits source and resource dependency tables and returns lengths,
UTF-8 byte count, line count, uniforms and function signatures with line numbers.
Uniform/function extraction is a **lexical navigation index**, with comments
masked; it is not an AST, type checker or authoritative validation result.
Ranges are 1-based/inclusive and retain exact line endings. `shader.length` and
hash still describe the complete source, with `partial: true` and range bounds
marking returned code. `length` uses JavaScript UTF-16 code units; `utf8_bytes`
counts encoded bytes. A final LF does not create an extra empty physical line.
Ranges cannot be combined with `metadata_only`.

Search uses the existing reader, including RSCC decoding and external Shader
resolution; no Python parser or additional compression dependency is required.
It visits `.material`, `.res`, `.tres`, `.shader` and `.gdshader` recursively,
skipping symlinks and `.git`, `.godot`, `.import`, `node_modules` directories.
Literal search is case-sensitive. Regex uses JavaScript syntax against each
individual line; results contain one record per matching line, not occurrence.
Paths, `shader_path`, `shader_hash`, line number and line text are returned.
`max_matches` defaults to 200 (maximum 10000); `offset`/`next_offset` paginate
matching lines in stable path order. `total_matches` still covers the scan.
Unreadable, corrupt or unsupported resources are reported in `errors` while
other files continue; `success: false` indicates an incomplete scan. Files such
as non-Shader `.tres` resources may therefore appear as explicit errors.

### NUL and validator profiles

Godot binary resource strings store a trailing NUL byte. The existing codec
consumes that terminator on read and emits it on serialization; it is not part
of `shader.code`, its hash, line numbering or diff. Do not strip arbitrary
characters in calling code. Embedded NUL in resource payloads is rejected, and
NUL supplied as source is rejected by the validated writer. No whitespace or
line-ending normalization is introduced.

`validate`, `write`, `write-patch` and `write-plan` accept `godot_version` and
`renderer`. Resource headers or the nearest project's config_version select
Godot 3 or 4 automatically. Detached raw source and direct strings default to
3.6; set `godot_version: "4.x"` for Godot 4. The bundled 3.6 compiler uses
`gles3`; installed Godot 4.3+ uses `dummy`. Batch entries may override the plan's
`godot_version` and `renderer`. Unsupported profiles fail closed. See the
[feature audit](docs/GODOT-4-FEATURE-PARITY.md) for editing and comparison parity.
Shader validation does not establish visual equivalence or GPU performance.

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
node scripts/release-package.mjs v1.3.0
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

- Binary files: Godot 3.5/3.6 format 3 and Godot 4.x formats 3–6;
  text formats 2–4. Unknown binary header flags or formats are rejected.
- Godot 3 uses the bundled 3.6 GLES3 compiler; supporting 3.5 headers does not
  claim full 3.5 language validation. Godot 4 needs an installed 4.3+ engine
  (4.5.1 is the tested reference); see its setup and context limits above.
- Little-endian resources only.
- RSCC compression mode `2` (ZSTD) and uncompressed RSRC only.
- The unused legacy `import_metadata_offset` header field is preserved exactly,
  including uint64 values above JavaScript's safe integer range. Actual internal
  resource offsets and resource body boundaries remain strictly validated.
- Material root must already be `ShaderMaterial`; `shader` must reference an
  internal or external `Shader`. Standalone roots must be `Shader`; existing
  `code` must be a non-empty String. No resource creation is supported.
- Deprecated embedded Image and InputEvent Variants are unsupported.
- Text ShaderMaterial reads, parameter diff/edits and embedded/external Shaders
  are supported. Recursive external material references are not supported.
- No scene recursion, texture decoding, new resources or arbitrary
  resource/property insertion/deletion.
- Bundled validator executables currently cover x64 Linux and x64 Windows.

See [`docs/GODOT-3.6-FORMAT.md`](docs/GODOT-3.6-FORMAT.md) for binary layout and
official Loader/Saver mapping, and
[`docs/WRITER-VALIDATION.md`](docs/WRITER-VALIDATION.md) for the recorded test,
native runtime, and PE inspection results.

### Material parameters and comparison

`godot-shader-read` now defaults to `params: true` (use `false` for source-only
reads). `params.materials` contains each internal ShaderMaterial, its
`internal_resource_index`, and `properties` entries with uniform `name`, original
property name, Variant `type`, `type_id`, and `value`. Color/vector values are
numeric arrays; real/double retain their original binary Variant type. Each
external texture parameter includes `external_resource: {id, type, path}`.
`params.external_resources` maps **zero-based table indices** to paths and
`bindings: [{internal_resource_index, uniform}]`; inline references have `id: null`.
For text materials these indices follow file order; they do not replace the
original numeric/string IDs in the file. Godot 4 parameters use
`shader_parameter/` instead of Godot 3 `shader_param/`.

Each material has a lexical `uniforms` index with `assigned`, `source`, and
`default_expression`, plus `unassigned_uniforms`. Nil/empty object parameters
count as unassigned. Defaults are reported as expressions, never evaluated.
Embedded Shader declarations are indexed per material; for external Shaders the
resolved root Shader is indexed. Other unresolved external Shaders report
`uniform_index_available: false`. Parameters also appear in metadata-only and
line-range reads. `resource_hash` is SHA-256 of the original material bytes.

`godot-shader-write-patch` accepts existing-parameter updates:

```json
{
  "path": "materials/road.material",
  "expected_resource_hash": "<resource_hash from read>",
  "expected_hash": "<shader.hash from read>",
  "ops": [
    {"setParam": {"name": "TexSize", "value": 1, "type": "real"}, "expect": 1},
    {"setParam": {"name": "Col", "value": [0.35, 0.38, 0.42, 1]}, "expect": 1},
    {"setParam": {"name": "ColFar", "value": [0.35, 0.38, 0.42, 1]}, "expect": 1}
  ]
}
```

`expect` asserts the number of matching properties across ShaderMaterials.
Supply `setParam.internal_resource_index` to select one material, and optional
`expected_value` to assert its exact stored old value (including float32
rounding). `type` asserts the existing Variant type; omitted type is preserved.
Supported updates: real, double, int, bool, string, Color and fixed-size numeric
vector/matrix/geometry tuples. Float32 values are rounded to their stored values;
non-finite/overflowing values, wrong shapes, type changes, missing parameters,
new parameters, and texture/reference mutations are rejected. External resources
and other properties remain unchanged. Results include `param_changes` and
before/after material hashes alongside the existing code diff and validation.

Code and parameter edits on one embedded material share an atomic transaction,
mandatory official Shader pre/post validation, temporary-file read-back, semantic
verification and concurrent-change checks. Parameter-only edits of a material
with an external Shader write **the material** and preserve the shared Shader.
A single patch combining material parameters and a changed external Shader is
rejected because it would require a two-file transaction. `dry_run` performs all
checks without replacing the original. `expected_hash` still guards only source;
use `expected_resource_hash` to guard parameter state. Write plans accept this
new hash and detect collisions using the actual material or Shader target.

`godot-shader-diff` takes `before` and `after` file paths. It returns a unified
Shader code diff, `parameter_diff` rows (added/removed/changed, types and values),
and a Markdown `difference_table`. Texture bindings compare resolved paths and
types, so a reordered external table alone produces no parameter difference.
Root materials match by role, internal materials by their local resource paths.
Optional `before_project_root`, `after_project_root`, `before_shader_path`, and
`after_shader_path` resolve external Shaders independently. All diff operations
are read-only. This comparison covers stored overrides, rather than evaluating
Shader default expressions or loading texture pixels.
