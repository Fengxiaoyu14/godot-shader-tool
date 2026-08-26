# Godot 3.6 ShaderMaterial Reader for OpenCode

`godot-shader-read` is a project-level, read-only OpenCode Custom Tool. It reads a Godot **3.6** binary `.material` or `.res`, follows `ShaderMaterial.shader` to its internal `Shader` resource, and returns the complete `Shader.code` string.

The implementation follows Godot `3.6-stable` commit `de2f0f147c5b7eff2d0f6dbc35042a4173fd59be`. It does not locate shaders by scanning for `shader_type`, `code`, the longest string, or a fixed sample offset.

## Install

Copy the included `.opencode` directory to the root of the target git worktree:

```text
your-project/
└── .opencode/
    └── tools/
        ├── godot-shader-read.ts
        └── godot_shader_reader/
            ├── binary-reader.ts
            ├── errors.ts
            ├── index.ts
            ├── resource.ts
            ├── rscc.ts
            ├── strings.ts
            └── variant.ts
```

OpenCode discovers the filename as the tool name `godot-shader-read`. The parser has no third-party runtime dependency; OpenCode supplies `@opencode-ai/plugin` and Bun. RSCC/ZSTD input requires Bun with `Bun.zstdDecompressSync` (Bun 1.2.14 or newer).

## Use

Ask the agent to inspect a binary material, or call the tool explicitly:

```text
godot-shader-read({
  path: "native_core/path/to/M_AvpSRSpot.material"
})
```

Paths are resolved from `context.worktree`. Both lexical `..` traversal and symlink escape are rejected. The implementation only calls read operations and never rewrites, backs up, or re-saves the resource.

Successful output has this shape:

```json
{
  "success": true,
  "path": "path/to/example.material",
  "container": {
    "format": "RSCC",
    "compression": "zstd",
    "compression_mode": 2,
    "block_size": 4096,
    "block_count": 2,
    "compressed_size": 2246,
    "compressed_payload_size": 2218,
    "uncompressed_size": 4800
  },
  "resource": {
    "type": "ShaderMaterial",
    "version_major": 3,
    "version_minor": 6,
    "format_version": 3,
    "big_endian": false,
    "use_real64": false,
    "external_resources": [],
    "internal_resources": []
  },
  "shader": {
    "subindex": 1,
    "internal_resource_index": 0,
    "code": "shader_type spatial;\n...",
    "length": 3541
  }
}
```

Failures return `success: false` and a structured `error` with a stable code. Unsupported Variants include the type id, resource, property, and absolute byte offset.

## Architecture

- `binary-reader.ts`: bounded primitive reads, endian handling, safe `u64`, and UTF-8 errors.
- `rscc.ts`: `RSCC` header/block table/footer parsing, per-block ZSTD decompression, and exact size checks.
- `strings.ts`: Godot `UnicodeString` and string-table/inline `StringName` decoding.
- `variant.ts`: the Godot 3.6 Variant subset needed by Shader/ShaderMaterial, plus common scalar, math, reference, and collection types.
- `resource.ts`: header and resource tables, internal resource spans, property tables, and structural Shader linking.
- `index.ts`: public byte-oriented reader.
- `godot-shader-read.ts`: OpenCode wrapper, path confinement, file I/O, and JSON errors.

See [Godot 3.6 binary layout](docs/GODOT-3.6-FORMAT.md) for the byte-level design and official-source mapping.

## Test

With Bun:

```bash
bun test ./.opencode/tools/godot_shader_reader/tests/*.test.ts
```

With Node.js 24 or newer:

```bash
node --experimental-strip-types --test .opencode/tools/godot_shader_reader/tests/*.test.ts
```

The suite contains 19 tests covering:

- RSCC sizes below, equal to, and above the block size, including exact multiples;
- single-block and multi-block files;
- invalid header, footer damage, compressed block damage, and decompressed-size mismatch;
- uncompressed RSRC;
- non-ShaderMaterial, missing Shader, missing code, unknown Variant, invalid magic, and truncation;
- exact Shader string comparison for both supplied real Godot 3.6 materials.

See [validation results](docs/VALIDATION.md) for the observed sample metadata and runtime results. The complete extracted sources are in `extracted/`; `manifest.json` records the exact embedded UTF-8 hash and terminal-newline state.

## Current limits

- Exactly Godot 3.6 (`version_major=3`, `version_minor=6`, binary `format_version=3`).
- `RSCC` compression mode `2` (ZSTD) and uncompressed `RSRC` only.
- Little-endian resources only; big-endian input returns `UNSUPPORTED_ENDIAN`.
- Root resource must be `ShaderMaterial`, and `shader` must be an internal `Shader` reference.
- Deprecated embedded Image and InputEvent Variants are intentionally unsupported. Unknown types fail fast rather than guessing a length.
- Maximum declared RSCC uncompressed size is 512 MiB as a memory-safety guard.
- No scene recursion, texture decoding, resource writeback, material editing, or Godot 4.x support.

## Extending Variants

Add the official Godot 3.6 type id and exact read order to `variant.ts`, then add both a valid fixture and a truncation/corruption test. Never skip an unknown Variant by an estimated size: a wrong estimate shifts every following property.

## Future `godot-shader-write`

Do not mutate the reader into an in-place patcher. Use a separate writer with:

1. a lossless resource model preserving string table entries, property order, subresource ids, and supported Variant values;
2. a two-pass serializer that writes resource bodies first conceptually, then calculates and emits every internal offset;
3. a separate RSCC encoder that rebuilds the block table and both `RSRC`/`RSCC` footers;
4. save-to-new-file plus reload-and-compare validation before any optional replacement of the original;
5. explicit refusal when the input contains an unsupported Variant that cannot be preserved losslessly.

This keeps the proven read-only path small and makes write safety auditable.
