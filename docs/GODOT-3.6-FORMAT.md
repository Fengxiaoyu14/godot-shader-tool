# Godot 3.6 binary resource layout used by this reader

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
