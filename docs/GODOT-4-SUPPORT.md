# Godot 4.x read / write / validate

The file APIs and OpenCode tools support Godot 4 `ShaderMaterial` and `Shader`
resources in RSRC / RSCC containers (binary format versions 3–6), text `.tres`
(formats 3–4), and standalone `.gdshader` source. Binary resources keep their
engine version, UID fields, script class, named internal IDs, dependencies,
property order and non-code values. Format versions or header flags outside the
supported set fail closed. Future Godot format changes are not assumed compatible.

Both embedded and external Shaders are supported. Text materials may use string
subresource IDs and `ExtResource` / `SubResource` references. `res://` resolves
through `project_root` or the nearest ancestor `project.godot`; UID-only paths
need an explicit `shader_path`, since the tool does not read Godot's UID cache.
Shared external writes change the actual Shader file and preserve the material.

## Install the Godot 4 compiler

Godot 3.6 keeps using the bundled standalone GLES3 validator. Godot 4 uses an
**installed official Godot 4.3 or newer executable**. Godot 4.5.1 is the tested
reference compiler. Download the standard engine from the official
[Godot releases](https://github.com/godotengine/godot/releases/tag/4.5.1-stable).
No editor window or GPU is required. Set this environment variable before
starting OpenCode:

```powershell
$env:GODOT4_BIN = 'C:\Tools\Godot\Godot_v4.5.1-stable_win64.exe'
```

```sh
export GODOT4_BIN=/opt/godot/Godot_v4.5.1-stable_linux.x86_64
```

Alternatively put `godot4` on PATH. The executable is intentionally not bundled
in this repository or its installation archives. Copy the **entire** tools
directory, including `validate-godot4.gd`, when installing the tools.

Each validation starts the official headless dummy renderer in a disposable
minimal project. Its `ShaderCompiler` invokes `ShaderLanguage` and `ShaderTypes`;
there is no replacement shader-language parser. Godot 4.0–4.2 executables are
rejected because their dummy backend does not compile shader code. A 4.x request
uses the installed engine's rules, and reports its actual major/minor version.
An explicit minor request, such as `4.3`, requires that same engine minor.
There is no promise that code validated by 4.5 also compiles in earlier minors.

The reported renderer is `dummy`. This validates syntax, types, built-ins and
render modes for spatial, canvas_item, particles, sky and fog shaders. It does
not test GPU rendering, renderer-specific code generation or visual output.
GPU renderer names (`forward_plus`, `mobile`, `gl_compatibility`) are rejected
as validator profiles rather than silently emulated.

## Use

```text
godot-shader-read({path: "/project/material.tres"})
godot-shader-validate({path: "/project/material.tres"})
godot-shader-write({
  path: "/project/material.tres",
  shader_code: "shader_type spatial;\nuniform vec4 tint : source_color;\nvoid fragment(){ ALBEDO=tint.rgb; }"
})
```

Resource paths select the compiler major automatically: binary major 4 or text
format 3/4 selects Godot 4, while Godot 3 resources retain Godot 3.6 validation.
A conflicting explicit major is rejected. Raw source files infer their major
from the nearest project.godot or an explicit project_root. Outside a recognizable
project, raw source defaults to 3.6. Direct source strings and detached Godot 4
source should select `godot_version: "4.x"`:

```text
godot-shader-validate({shader_code: "shader_type sky;\nvoid sky(){ COLOR=vec3(0.5); }", godot_version: "4.x"})
godot-shader-write({path: "/project/main.gdshader", shader_code: "shader_type canvas_item;\nvoid fragment(){ COLOR=vec4(1.0); }", godot_version: "4.x"})
```

Godot 4 writes retain mandatory pre/post official compilation, sibling temporary
file read-back, exact code comparison, semantic preservation, stale-hash checks,
dry-run and safe file replacement. Missing engines, timeouts, runtime failures,
unknown output and shader errors prevent replacement. Code is not migrated from
Godot 3 automatically; callers must provide Godot 4 shader source.

Validation is isolated from the user's project configuration. Shader includes
and global shader uniforms that depend on project resources/settings cannot be
resolved in that minimal project and fail closed. `project_root` currently
controls resource-file reference resolution, not the validation environment.

## Verification

`tests/godot_shader_reader/fixtures/godot4/` contains small resources saved by the
official Godot 4.5.1 engine. The adjacent generator records how to reproduce them.
The regression suite exercises RSRC, ZSTD RSCC, text and standalone files,
embedded/named and external references, Godot 4 parameter names, new Variant
types, invalid shaders, pre/post validation, dry-run, original preservation and
official-engine reload after every write. CI runs on Windows and Linux.

```powershell
$env:GODOT4_BIN = 'C:\Tools\Godot\Godot_v4.5.1-stable_win64.exe'
node --test tests/godot_shader_reader/*.test.ts
```

Use Node 24 for repository tests; OpenCode supplies Bun for the installed tools.
Engine integration tests skip when `GODOT4_BIN` is absent; CI installs it explicitly.

## Editing feature parity

Patch editing, parameter diff/updates, batch plans, search and installed wrappers
are covered in the [3.x / 4.x feature audit](GODOT-4-FEATURE-PARITY.md). Text
materials expose parameter values and resource hashes. Batch entries may supply
`godot_version` and `renderer` independently.
