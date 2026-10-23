# Godot 3.x / 4.x feature audit

The existing OpenCode tools were compared using Godot 4.5.1 for official
compilation and edited-resource reload verification.

| Existing feature | Godot 4 binary / compressed | Godot 4 text / source | Audit result |
| --- | --- | --- | --- |
| Complete source, hashes, metadata-only and line ranges | Supported | Supported | Regression tested |
| Count-asserted literal patches and exact line deletion | Supported | Supported | Regression tested |
| Unified code diff and dry-run | Supported | Supported | Regression tested |
| Parameter reads and uniform assignment index | Supported | Supported for text materials | Fixed missing text parameter output |
| Parameter diff and texture paths | Supported | Supported for text materials | Fixed missing text parameter diffs |
| Existing parameter edits (`setParam`) | Supported | Supported for text materials | Added text value-span rewriting |
| Count, type and old-value assertions | Supported | Supported | Includes multiple internal materials |
| Source and resource hash guards | Supported | Supported | Added text resource hashes; check source hash before operations |
| Embedded code + parameter transaction | Supported | Supported | Regression tested |
| External parameter-only changes | Supported | Supported | Shared Shader stays unchanged |
| Mixed external code + parameter changes | Rejected | Rejected | Same two-file transaction limit as 3.x |
| Batch plans and per-file failure isolation | Supported | Supported | Added per-entry profiles; fixed Windows target path comparison |
| Duplicate shared-target preflight | Supported | Supported | Tested across binary and text materials |
| Recursive search, regex, pagination and hashes | Supported | Supported | Regression tested |
| Installed tool wrappers | Supported | Supported | Package tests cover read/write/validate/patch/diff/plan/search |

## Gaps fixed

Text materials previously exposed code without `params` or `resource_hash`.
Parameter comparison could incorrectly report equality, and parameter edits
attempted to use the binary codec. Text parameters now use the same public
output shape as binary materials. Text resource indices are deterministic
file-order indices. Original IDs and references stay unchanged; textures are
not opened.

Text edits replace only asserted parameter-value spans and, if requested,
the selected embedded Shader.code string. Headers, IDs, UIDs, comments,
metadata, unrelated properties, existing BOM and unaffected line endings
stay exact. Read-back checks the expected bytes and re-parses values/types.
Opaque unsupported values stay visible in read/diff and cannot be edited.

Scalar/Color/vector edits also support Vector4, integer vectors, Projection,
StringName, int64 and packed arrays. Int64 uses decimal strings to avoid
JavaScript precision loss. Color and packed Float32 remain single precision;
double-precision real_t resources retain precision for scalar/vector edits.

Raw source now infers its major from the nearest project.godot
(`config_version=5` for Godot 4, `4` for Godot 3), or an explicit project_root.
Outside a recognizable project, raw source defaults to 3.6; detached Godot 4
source and direct source strings should specify `godot_version: "4.x"`.

Batch entries may override the plan's default compiler settings:

```json
[
  {
    "path": "legacy.material",
    "godot_version": "3.6",
    "renderer": "gles3",
    "ops": [{"find": "vec3(1.0)", "replace": "vec3(0.5)", "expect": 1}]
  },
  {
    "path": "modern.gdshader",
    "godot_version": "4.x",
    "renderer": "dummy",
    "ops": [{"find": "vec3(1.0)", "replace": "vec3(0.5)", "expect": 1}]
  }
]
```

## Scope boundaries

Resource creation, arbitrary property insertion/deletion, texture decoding,
two-file atomic edits, scene recursion and GPU visual tests were not supported
by the original 3.x tools and remain outside this editing scope.
Project-dependent includes/global-uniform validation retains the isolated
compiler limits in [Godot 4 support](GODOT-4-SUPPORT.md).
Preserving an existing BOM does not imply that every engine's resource loader
accepts that original BOM-bearing file.
