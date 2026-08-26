# Godot 3.6 Shader Writer validation

Validation date: 2026-08-26.

## Authority and runtimes

- Godot source and executable: `3.6-stable`, commit/version `de2f0f147`.
- Node.js: `24.19.0`, with `node:zlib` ZSTD injected into the codec.
- Bun: `1.4.0`, exercising the production `Bun.zstdDecompressSync` and `Bun.zstdCompressSync` paths.

The normal synthetic command runs 81 tests: 80 pass and the opt-in private Golden test skips when `GODOT_SHADER_GOLDEN` is unset. The same Golden test was then run separately against both available private real materials under Node and Bun; all four runs passed.

Both OpenCode wrapper modules were imported with `@opencode-ai/plugin` `1.18.23`. A Bun end-to-end call wrote a synthetic material through `godot-shader-write`, then read it through `godot-shader-read`; the exact 37-character UTF-8/CRLF replacement matched.

## Real-material results

Real files and extracted Shader source are deliberately not committed. The table contains only structural test measurements.

| Sample | Original physical/logical bytes | Original blocks | Original Shader chars | No-op output | Shorter output | Longer output | Unicode + CRLF + cross-block output |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| `c81d93d5-ff45-4566-a6db-4b9f804826a0.material` | 2246 / 4800 | 2 | 3541 | 2246 bytes, 2 blocks | 1770 chars, 1 block | 5542 chars, 2 blocks | 9555 chars, 3 blocks |
| `157bbb1c-dab3-4ab4-9e94-c3e7e0b5c7ab.material` | 1411 / 3235 | 1 | 1887 | 1410 bytes, 1 block | 943 chars, 1 block | 3888 chars, 2 blocks | 7901 chars, 3 blocks |

Every case passed all three mandatory validations:

```json
{
  "read_back": true,
  "shader_code_match": true,
  "only_shader_changed": true
}
```

The real resources exercised String, Nil, Real, Color, and internal/external Object references; one also exercised Vector2. The complete synthetic Variant suite covers every additional Variant supported by the codec.

The private source files were opened read-only. All write tests operated on unique system-temporary copies, and source SHA-256 values were unchanged after validation.

## Godot executable validation

Writer outputs derived from both real materials were independently loaded by the official `Godot_v3.6-stable_linux_headless.64`. Both runs returned:

```text
GODOT_VALIDATION_OK
```

This proves that Godot recognizes the reserialized outputs as `ShaderMaterial` resources with non-null internal `Shader` resources. Godot 3.6's headless build uses a null VisualServer, so `Shader.get_code()` is not an independent source-code oracle there; exact source equality is instead enforced by the codec's byte-level read-back and semantic validator.

## Failure safety

Automated tests verify that invalid Shader input and injected ZSTD failure leave the original bytes and directory contents unchanged. Additional forced-Windows tests verify both successful two-stage replacement and restoration of the original when the destination rename fails.
