# Godot 3.6 standalone shader validator patches

The validator is built from the official Godot `3.6-stable` source at commit
`de2f0f147c5b7eff2d0f6dbc35042a4173fd59be`. The complete upstream source is
not vendored. `scripts/prepare-godot.sh` checks out that exact commit and applies
`patches/godot-3.6-standalone-gles3.patch`.

## What is compiled

The executable compiles Godot's own `servers/visual/shader_language.cpp` and
`servers/visual/shader_types.cpp`. It links the pinned Godot Core static archive
needed by those translation units. It does not contain another parser, regular
expression checks, `glslang`, or generated copies of Godot's shader definitions.

`ShaderLanguage::compile()` receives the function, render-mode, built-in, and
stage definitions produced directly by `ShaderTypes`. Consequently the result
matches Godot 3.6's ShaderLanguage semantic checks, including identifiers,
types, built-ins, render modes, arrays, `switch`, and GLES3-only integer types.

## The four-file patch

The patch is deliberately narrow:

1. `core/string_name.h` exposes the existing private `StringName::setup()` as
   `setup_standalone()` only when `GODOT_SHADER_STANDALONE` is defined.
2. `servers/visual/shader_language.cpp` routes all nine existing
   `VisualServer::get_singleton()->is_low_end()` call sites through one helper.
   The standalone helper always returns `false`, which fixes the validator to
   Godot 3.6 GLES3. Normal Godot builds retain the original VisualServer call.
3. `servers/visual/shader_types.h` substitutes a standalone declaration of the
   exact three `VS::ShaderMode` values when the standalone macro is enabled.
4. `servers/visual/shader_mode_standalone.h` supplies only those enum values and
   carries the Godot MIT header.

There is intentionally no command-line renderer/backend option. The validator
always reports `godot_version: "3.6"` and `renderer: "gles3"`.

You can verify that the patch still applies cleanly with:

```bash
validator/scripts/prepare-godot.sh
```

The script refuses a different commit or incompatible local changes instead of
silently patching an unknown Godot tree.

## Minimal initialization and stubs

The process does not call Godot's engine startup, create an `OS`, `Main`,
`VisualServer`, project, window, rendering device, OpenGL context, or GPU object.
Its initialization sequence is only:

1. read UTF-8 shader source;
2. initialize Godot's `StringName` intern table;
3. construct `ShaderTypes` and `ShaderLanguage`;
4. call the official parser/compiler once;
5. emit one JSON object and terminate.

The intern table is intentionally process-lifetime state. Godot's normal
`StringName::cleanup()` diagnostic path assumes that a live `OS` singleton
exists; this standalone process deliberately has no `OS`. The operating system
reclaims the table at process exit, avoiding an invalid engine-shutdown call.

`src/godot_stubs.cpp` contains only link-boundary adapters:

- Godot print/error hooks are silent so stdout remains JSON-only.
- `Input::get_axis()` and `Input::get_vector()` are copied from Godot 3.6 because
  Core's ClassDB tables retain their addresses even though Input is never
  initialized or called.
- two `AudioDriverManager` accessors return an empty driver set for COFF archive
  references retained by MinGW. The validator has no audio path.

Core and the validator are compiled with function/data sections, and the final
link uses section garbage collection. The Windows build also uses static
libgcc/libstdc++, so its inspected imports are limited to Windows system CRT/API
DLLs. `scripts/inspect-windows.sh` enforces that allowlist.

## Licensing

`LICENSE.txt` contains the Godot Engine MIT license. The patch's new Godot-side
header carries the same notice. Keep both files with source and binary
redistributions.
