# Godot 3.6 Shader validator/writer verification

Verification date: 2026-08-26.

## Authority and build environment

- Godot source: official `3.6-stable` commit
  `de2f0f147c5b7eff2d0f6dbc35042a4173fd59be`.
- Native compiler: GCC 13.3.0 on x86-64 Linux.
- Cross compiler: MinGW-w64 GCC 13-posix targeting x86-64 Windows.
- Test runtime: Node.js 24.19.0.
- Shader backend: fixed Godot GLES3 semantics (`low_end=false`).

The clean standalone patch was checked with `git apply --check` against the
pinned commit. Both artifacts were then rebuilt from that patched tree through
the committed scripts. No Godot project, engine main loop, VisualServer, window,
OpenGL context, or GPU was used.

## Automated results

The Node suite reports 105 tests: 104 pass and one private Golden Material test
skips when `GODOT_SHADER_GOLDEN` is unset. The standalone CLI matrix adds 13
successful checks for file/stdin modes, JSON-only output, exit codes, all shader
classes, and positive/negative language fixtures.

Official-parser fixture coverage includes:

| Case | Expected result |
| --- | --- |
| spatial fragment | valid |
| canvas_item fragment | valid |
| particles vertex | valid |
| `INSTANCE_CUSTOM` built-in | valid |
| valid render-mode list | valid |
| unknown render mode | invalid with line/message |
| syntax error | invalid with line/message |
| unknown identifier | invalid with line/message |
| GLES3 `uint` / `uvec3` | valid |
| global/local initialized arrays | valid |
| `switch` | valid |

The global-array fixture is also a shutdown regression test. `StringName` uses
process-lifetime storage because the normal Godot cleanup diagnostic requires an
`OS` singleton that intentionally does not exist in this standalone program.

## Validation process failure coverage

Tests force each of these states and require a structured, fail-closed error:

- executable missing or unsupported platform/architecture;
- executable stdout is not valid JSON;
- timeout;
- internal/nonstandard process exit;
- ordinary shader rejection.

The OpenCode wrapper test copies the production tools and bundled native binary
to a clean temporary layout, loads all three wrapper modules through an
API-compatible `@opencode-ai/plugin` test shim, and performs:

```text
direct validation
→ binary-material path validation
→ valid write with pre/post official checks
→ read exact Unicode/CRLF source back
→ rejected invalid write
→ confirm original bytes unchanged
```

The actual OpenCode package and Bun are supplied by OpenCode and are not present
in this build container; the test shim only returns each production tool
definition unchanged and implements its string-schema chain.

## Writer failure safety

Automated tests verify all mandatory gates:

- valid source is checked before serialization and from actual temp read-back;
- invalid source fails at `pre_write` and leaves original bytes unchanged;
- unavailable validator fails before serialization and leaves no temp file;
- injected `post_write` rejection removes the temp and preserves the original;
- injected ZSTD compression failure preserves the RSCC original;
- forced Windows second-stage rename failure restores the original;
- concurrent original-byte changes are rejected by the implementation before
  replacement.

A successful write reports all five gates:

```json
{
  "pre_write_shader": true,
  "resource_read_back": true,
  "shader_code_match": true,
  "semantic_diff": true,
  "post_write_shader": true
}
```

The codec tests additionally cover every readable/writable Variant, RSRC and
RSCC round trips, Godot's exact-multiple empty-block rule, offset recalculation,
multi-block growth, Unicode, and exact LF/CRLF retention.

## Golden Material

Real project materials and extracted source are intentionally excluded. When a
private Godot 3.6 ShaderMaterial is supplied through `GODOT_SHADER_GOLDEN`, the
opt-in test first compiles its original Shader with the official validator. It
then exercises valid no-op, shorter, longer, Unicode/CRLF, and cross-block
writes. Syntax-error and unknown-identifier variants must be rejected with the
source bytes unchanged.

No private Golden path was supplied for the recorded run, so this case is the
single documented skip rather than an unverified pass.

## Windows x64 artifact inspection

Wine is not installed in this environment, so the Windows executable was not
claimed as a runtime execution result. Its identical C++ sources and pinned
Godot sources were exercised by the native binary; the cross-built artifact was
verified structurally:

```text
format:  PE32+ executable (console), x86-64
imports: KERNEL32.dll, msvcrt.dll
size:    approximately 3.1 MiB after stripping
```

`validator/scripts/inspect-windows.sh` enforces those properties and rejects any
additional DLL, including Godot, OpenGL, libgcc, or libstdc++ imports. The stable
path is `.opencode/tools/bin/windows-x64/godot-shader-validator.exe`.

The companion native binary is approximately 416 KiB after stripping. Final
SHA-256 values are committed in `validator/SHA256SUMS`.
