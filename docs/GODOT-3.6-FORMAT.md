# Godot 3.6 binary resource layout used by the reader and writer

Authority: the official Godot `3.6-stable` tag, commit `de2f0f147c5b7eff2d0f6dbc35042a4173fd59be`.

## RSCC container

The physical compressed file is:

| Field | Encoding |
| --- | --- |
| magic | 4 bytes, `RSCC` |
| compression mode | `u32`; `2` is ZSTD |
| block size | `u32`; saver default is 4096 |
| total uncompressed size | `u32` |
| compressed sizes | `block_count × u32` |
| compressed blocks | consecutive ZSTD frames |
| footer | 4 bytes, `RSCC` |

Godot computes:

```text
block_count = floor(uncompressed_size / block_size) + 1
```

This is intentionally not ceiling division. When the size is an exact block-size multiple, the saver emits an additional compressed empty block. Every block is decompressed independently and verified against its expected size.

Source: [`FileAccessCompressed::open_after_magic` and `close`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/file_access_compressed.cpp#L61-L177); compression mode ordering: [`Compression::Mode`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/compression.h#L41-L47).

## RSRC logical stream

For an uncompressed resource, the physical file begins with `RSRC`, so its header starts at physical offset 4 and stored internal offsets include that prefix.

For a compressed resource, the saver does **not** write a leading `RSRC` into the compressed logical stream. Its header starts at logical offset 0. In both forms, the logical resource ends with `RSRC`.

This follows the saver branches and final footer write in [`ResourceFormatSaverBinaryInstance::save`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L1660-L1867).

The header/table order is:

1. `u32 big_endian`;
2. `u32 use_real64`;
3. `u32 version_major`;
4. `u32 version_minor`;
5. `u32 format_version`;
6. `UnicodeString resource_type`;
7. `u64 import_metadata_offset`;
8. 14 reserved `u32` fields;
9. `u32 string_table_size`, then that many `UnicodeString` values;
10. `u32 external_resource_count`, then `type` and `path` strings for each;
11. `u32 internal_resource_count`, then `path` and `u64 offset` for each;
12. internal resource bodies;
13. `RSRC` footer.

Source: [`ResourceInteractiveLoaderBinary::open`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L795-L891).

## Strings and properties

`UnicodeString` is `u32 length` followed by exactly that many UTF-8 bytes. Godot's saver stores `utf8.length + 1` and includes the trailing NUL; no four-byte padding is added.

Source: [`get_unicode_string`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L767-L780) and [`save_unicode_string`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L1651-L1660).

An internal resource body is:

```text
UnicodeString resource_type
u32 property_count
repeat property_count:
    encoded property name
    encoded Variant value
```

Property names normally use a `u32` string-table index. If bit 31 is set, bits 0–30 are an inline UTF-8 byte length and the bytes follow immediately.

Source: [`_get_string`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L104-L124) and the internal loader in [`poll`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L646-L728).

## Structural Shader lookup

The final internal table entry is the main resource. This reader:

1. verifies the file-level and main internal types are both `ShaderMaterial`;
2. parses the main property table and requires `shader` to be Variant type `OBJECT`, subtype `OBJECT_INTERNAL_RESOURCE`;
3. reads its subindex and finds the matching internal table path `local://<subindex>`;
4. requires that body type to be `Shader`;
5. parses its properties and requires `code` to be Variant type `STRING`.

No shader text participates in locating any of these structures. `shader_type` is only suitable as an optional post-extraction sanity check.

Variant ids and object subtypes come directly from [`resource_format_binary.cpp`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L43-L94); the official parse order is in [`parse_variant`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L126-L614).

## Saver pipeline implemented by the writer

Godot's Saver does more than reverse the Loader. Its order is:

1. recursively discover internal/external resources and property-name/NodePath strings;
2. build `ResourceData` property lists and the string table;
3. write the header, string table, and external-resource table;
4. write every internal path and reserve a zero `u64` offset;
5. write every complete internal resource body while recording actual positions;
6. seek back and patch the reserved offset table;
7. seek to the end and write the `RSRC` footer;
8. when compression is enabled, let `FileAccessCompressed::close` rebuild the complete RSCC block table and payload.

Source: [`ResourceFormatSaverBinaryInstance::save`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L1672-L1873).

This project follows the same two-pass offset behavior. Old internal offsets are diagnostic input only; none are copied or adjusted by a Shader-length delta.

The shared IR preserves:

- the Godot version/header flags and 14 reserved values;
- the original string table plus any required missing property names;
- external resource order/type/path;
- internal resource order/path/type;
- property order/name;
- each Variant's binary `type_id` and typed value.

Import metadata is the one header feature not modeled. The Reader reports its offset, but the Writer refuses non-zero `import_metadata_offset` instead of copying a stale physical offset after reserialization.

## Variant serialization

Every Variant begins with its Godot binary type id. Scalar and math values then follow in the exact order used by [`ResourceFormatSaverBinaryInstance::write_variant`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/resource_format_binary.cpp#L1248-L1562).

Important special cases:

- `Int64` is an eight-byte signed integer; `Double` is IEEE-754 f64.
- math types and packed real/vector/color arrays store f32 components.
- `NodePath` stores two `u16` counts, with the absolute flag in bit 15 of the subname count, then string-table or inline StringName references.
- Object references have separate empty, internal-subindex, legacy inline-external, and external-table-index subtypes.
- Dictionary and Array recursively serialize complete Variants.
- PoolByteArray is padded with zero bytes to the next four-byte boundary; other packed arrays are not padded.

Unknown Variant ids cannot be safely skipped because their byte length is unknown. The Reader fails with `UNSUPPORTED_VARIANT_TYPE`; the Writer fails with `UNSUPPORTED_VARIANT_FOR_WRITE` and includes the resource type and property name.

## Container-preserving output

The container metadata captured by the Reader controls output:

| Input | Logical stream emitted | Physical output |
| --- | --- | --- |
| RSRC | leading `RSRC`, header/tables/bodies, trailing `RSRC` | unchanged uncompressed strategy |
| RSCC | header/tables/bodies, trailing `RSRC` (no leading logical magic) | new `RSCC` using the original mode and block size |

For RSCC, each logical slice is compressed as its own ZSTD frame. Both single-block and multi-block files, including the exact-multiple empty final block, use the same algorithm as [`FileAccessCompressed::close`](https://github.com/godotengine/godot/blob/de2f0f147c5b7eff2d0f6dbc35042a4173fd59be/core/io/file_access_compressed.cpp#L138-L178).

Compressed bytes do not need to match Godot's bytes. Compatibility is established by exact decompression, full Resource parsing, and semantic equality.

## Shader-only validation

After serialization, the Writer parses the output again with the shared Reader. Validation requires exact equality for every modeled header field, external resource, internal resource, property name/order, reference, and Variant value except the one located `Shader.code` String. That one value must be exactly equal to the requested JavaScript string, including UTF-8 text, LF/CRLF, and final-newline presence.
