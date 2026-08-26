# Godot 3.6 Shader Read/Write Tools for OpenCode

This project provides two OpenCode Custom Tools for Godot **3.6** binary `ShaderMaterial` resources:

- `godot-shader-read` reads the complete embedded `Shader.code`.
- `godot-shader-write` replaces the complete `Shader.code`, fully reserializes the resource, validates a sibling temporary file, and only then replaces the original.

Global installation is recommended so the tools are available in every worktree. The implementation follows Godot `3.6-stable` commit [`de2f0f147c5b7eff2d0f6dbc35042a4173fd59be`](https://github.com/godotengine/godot/tree/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be). It does not scan for shader-looking text, use fixed offsets, splice binary bytes, or patch later offsets by a Shader-length delta.

## Install

### Global installation (recommended)

OpenCode discovers global custom tools in `~/.config/opencode/tools/`. Run the following commands from the root of this repository.

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

Restart OpenCode after copying the files. The installed layout is:

```text
~/.config/opencode/
└── tools/
    ├── godot-shader-read.ts
    ├── godot-shader-write.ts
    └── godot_shader_reader/
        ├── binary-reader.ts
        ├── binary-writer.ts
        ├── codec.ts
        ├── errors.ts
        ├── file-writer.ts
        ├── input-path.ts
        ├── index.ts
        ├── resource.ts
        ├── resource-writer.ts
        ├── rscc.ts
        ├── rscc-writer.ts
        ├── strings.ts
        ├── variant.ts
        └── variant-writer.ts
```

Add the following entries to your global or project `opencode.json` so reads are automatic but writes require confirmation:

```json
{
  "permission": {
    "godot-shader-read": "allow",
    "godot-shader-write": "ask"
  }
}
```

OpenCode supplies `@opencode-ai/plugin` and Bun. RSCC/ZSTD input needs `Bun.zstdDecompressSync`; RSCC output needs `Bun.zstdCompressSync`.

### Project-only installation (optional)

To make the tools available in one repository only, copy `.opencode` and `opencode.json` to that worktree's root:

```text
your-project/
├── opencode.json
└── .opencode/
    └── tools/
        ├── godot-shader-read.ts
        ├── godot-shader-write.ts
        └── godot_shader_reader/
            └── ...
```

## Use

Read the complete Shader source:

```text
godot-shader-read({
  path: "/absolute/path/to/example.material"
})
```

Replace it with a complete source string:

```text
godot-shader-write({
  path: "/absolute/path/to/example.material",
  shader_code: "shader_type spatial;\n..."
})
```

Absolute paths are recommended when OpenCode runs the session in a temporary worktree. Relative paths are resolved from `context.worktree`. Both tools accept paths outside that worktree when the OpenCode process has OS permission; the write tool still requires the configured `ask` confirmation.

`shader_code` must be non-empty. It is stored exactly: the writer does not trim, format, normalize indentation, or convert LF/CRLF. It deliberately does not try to compile or regex-validate Godot Shader syntax.

A successful write returns compact metadata rather than echoing the complete Shader:

```json
{
  "success": true,
  "path": "/absolute/path/to/example.material",
  "resource_type": "ShaderMaterial",
  "validation": {
    "read_back": true,
    "shader_code_match": true,
    "only_shader_changed": true
  },
  "before": {
    "shader_length": 1401
  },
  "after": {
    "shader_length": 1732
  }
}
```

## Write safety

Every write follows this sequence:

```text
read original
→ parse complete resource IR
→ replace existing Shader.code
→ fully serialize every header/table/resource body
→ recompute all internal-resource offsets
→ rebuild RSCC blocks when applicable
→ write and fsync a unique sibling temp file
→ read the temp file through the shared reader
→ require exact Shader.code equality
→ semantic-diff every resource and property
→ verify the original did not change concurrently
→ replace the original
```

Only the located `Shader.code` String Variant may differ. Resource versions, container strategy, external resources, internal paths/order/types, property names/order, object references, Shader parameters, and all other Variant values must remain equal.

Before replacement, parse, serialization, compression, temporary-file, read-back, or validation failures leave the original untouched. POSIX uses same-directory atomic `rename`. Windows uses a recoverable two-stage replacement because replacing an existing destination has different platform semantics; if the second rename fails, the original is restored.

## Shared IR and codec

The reader parses every internal resource into a shared, typed model:

```typescript
interface GodotResource {
  bigEndian: boolean
  useReal64: boolean
  versionMajor: number
  versionMinor: number
  formatVersion: number
  type: string
  importMetadataOffset: number
  reservedFields: number[]
  stringTable: string[]
  externalResources: ExternalResource[]
  internalResources: InternalResourceEntry[]
  parsedInternalResources: ParsedInternalResource[]
}
```

Each property retains its Godot Variant `type_id`, modeled type, and value. The public codec flow is:

```typescript
const parsed = parseResource(bytes)
const code = getShaderCode(parsed.resource)
setShaderCode(parsed.resource, replacement)
const output = serializeResource(parsed)
```

The original table offsets remain available for diagnostics only. `resource-writer.ts` always reserves and patches a new offset table from actual writer positions.

## Supported Variant write subset

The writer supports every non-deprecated Variant currently supported by the reader:

- Nil, Bool, Int, Int64, Real, Double, and String;
- Vector2, Rect2, Vector3, Plane, Quat, AABB, Basis, Transform, Transform2D, and Color;
- NodePath and RID;
- empty, internal, indexed external, and legacy inline external Object references;
- Dictionary and Array;
- PoolByteArray, PoolIntArray, PoolRealArray, PoolStringArray, PoolVector2Array, PoolVector3Array, and PoolColorArray.

Unknown types fail with `UNSUPPORTED_VARIANT_FOR_WRITE`; they are never skipped, zeroed, guessed, or preserved as opaque byte spans.

## Test

Use Node.js 24 or newer from the repository root:

```bash
node --experimental-strip-types --test ".opencode/tools/godot_shader_reader/tests/*.test.ts"
```

Bun 1.4 or newer can run the same suite:

```bash
bun test ./.opencode/tools/godot_shader_reader/tests/*.test.ts
```

The synthetic suite covers absolute/worktree-relative paths, primitive writer growth/patching, UTF-8 strings, every supported Variant, RSRC and RSCC semantic round-trips, the Godot exact-multiple empty-block rule, shorter/longer Shader offsets, multi-block growth, Unicode, LF/CRLF, temporary-file cleanup, failure-before-replace safety, and forced Windows restore behavior.

Real project materials are intentionally excluded from this public repository. Run the same no-op/shorter/longer/Unicode/multi-block test against a private Golden Sample with:

```bash
GODOT_SHADER_GOLDEN=/absolute/path/to/M_AvpSRSpot.material \
node --experimental-strip-types --test \
  .opencode/tools/godot_shader_reader/tests/golden-material.test.ts
```

For an independent engine-load check, place a Writer output at `godot-validation/output.material` and run:

```bash
Godot_v3.6-stable_linux_headless.64 \
  --path godot-validation \
  -s godot-validation/validate_material.gd
```

The validation script requires Godot to load a `ShaderMaterial` with a non-null `Shader`. Godot's 3.6 headless build uses a null VisualServer, so it cannot independently return `Shader.code`; exact code equality remains enforced by the Writer's byte-level read-back.

## Current limits

- Exactly Godot 3.6 (`version_major=3`, `version_minor=6`, binary `format_version=3`).
- Little-endian resources only.
- RSCC compression mode `2` (ZSTD) and uncompressed RSRC only.
- Writer requires `import_metadata_offset == 0`; import metadata payloads are not modeled.
- Root resource must already be `ShaderMaterial`; `shader` must already reference an internal `Shader`; `code` must already be a non-empty String Variant.
- Deprecated embedded Image and InputEvent Variants are unsupported.
- No Godot 4.x, scene recursion, texture decoding, shader compilation, partial text patches, new resources, or resource/property insertion/deletion.

See [docs/GODOT-3.6-FORMAT.md](docs/GODOT-3.6-FORMAT.md) for the byte layout and official Loader/Saver source mapping, and [docs/WRITER-VALIDATION.md](docs/WRITER-VALIDATION.md) for synthetic, private real-material, Bun/Node, failure-safety, OpenCode wrapper, and Godot executable results.
