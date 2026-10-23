import { Tokens } from "./text-shader.ts"
import { VARIANT, type ExternalResource, type VariantValue } from "./variant.ts"
import { GodotReaderError } from "./errors.ts"

export interface TextVariantContext {
  externalIds: Map<string, number>
  internalIds: Map<string, number>
  externalResources: ExternalResource[]
}

const constructors: Record<string, [string, number, number?]> = {
  Vector2: ["vector2", VARIANT.VECTOR2, 2], Rect2: ["rect2", VARIANT.RECT2, 4],
  Vector3: ["vector3", VARIANT.VECTOR3, 3], Vector4: ["vector4", VARIANT.VECTOR4, 4],
  Vector2i: ["vector2i", VARIANT.VECTOR2I, 2], Rect2i: ["rect2i", VARIANT.RECT2I, 4],
  Vector3i: ["vector3i", VARIANT.VECTOR3I, 3], Vector4i: ["vector4i", VARIANT.VECTOR4I, 4],
  Plane: ["plane", VARIANT.PLANE, 4], Quaternion: ["quat", VARIANT.QUAT, 4], Quat: ["quat", VARIANT.QUAT, 4],
  AABB: ["aabb", VARIANT.AABB, 6], Basis: ["basis", VARIANT.MATRIX3, 9],
  Transform3D: ["transform", VARIANT.TRANSFORM, 12], Transform: ["transform", VARIANT.TRANSFORM, 12],
  Transform2D: ["transform2d", VARIANT.MATRIX32, 6], Projection: ["projection", VARIANT.PROJECTION, 16],
  Color: ["color", VARIANT.COLOR, 4], StringName: ["string_name", VARIANT.STRING_NAME],
  PackedByteArray: ["raw_array", VARIANT.RAW_ARRAY], PoolByteArray: ["raw_array", VARIANT.RAW_ARRAY],
  PackedInt32Array: ["int_array", VARIANT.INT_ARRAY], PoolIntArray: ["int_array", VARIANT.INT_ARRAY],
  PackedInt64Array: ["int64_array", VARIANT.INT64_ARRAY],
  PackedFloat32Array: ["real_array", VARIANT.REAL_ARRAY], PoolRealArray: ["real_array", VARIANT.REAL_ARRAY],
  PackedFloat64Array: ["double_array", VARIANT.DOUBLE_ARRAY],
  PackedStringArray: ["string_array", VARIANT.STRING_ARRAY], PoolStringArray: ["string_array", VARIANT.STRING_ARRAY],
  PackedVector2Array: ["vector2_array", VARIANT.VECTOR2_ARRAY, 2], PoolVector2Array: ["vector2_array", VARIANT.VECTOR2_ARRAY, 2],
  PackedVector3Array: ["vector3_array", VARIANT.VECTOR3_ARRAY, 3], PoolVector3Array: ["vector3_array", VARIANT.VECTOR3_ARRAY, 3],
  PackedVector4Array: ["vector4_array", VARIANT.VECTOR4_ARRAY, 4],
  PackedColorArray: ["color_array", VARIANT.COLOR_ARRAY, 4], PoolColorArray: ["color_array", VARIANT.COLOR_ARRAY, 4],
  Callable: ["callable", VARIANT.CALLABLE], Signal: ["signal", VARIANT.SIGNAL],
}

/** Resource Variants only. Shader syntax is always checked by the official engine. */
export function parseTextVariant(raw: string, context: TextVariantContext): VariantValue {
  const tokens = new Tokens(raw)
  const make = (type: string, type_id: number, value: unknown): VariantValue => ({ type, type_id, value })
  function sequence(end: string, depth: number): VariantValue[] {
    const values: VariantValue[] = []
    while (tokens.peek().value !== end || tokens.peek().kind !== "symbol") {
      if (values.length >= 1_000_000) tokens.fail("Resource array exceeds the safety limit")
      values.push(value(depth + 1))
      if (tokens.peek().value === end && tokens.peek().kind === "symbol") break
      tokens.expect(",")
    }
    tokens.expect(end)
    return values
  }
  function value(depth: number): VariantValue {
    if (depth > 64) tokens.fail("Resource Variant nesting is too deep")
    const token = tokens.next()
    if (token.kind === "string") return make("string", VARIANT.STRING, token.value)
    if (token.kind === "symbol" && token.value === "[") return make("array", VARIANT.ARRAY, sequence("]", depth))
    if (token.kind === "symbol" && token.value === "{") {
      const entries: Array<{ key: VariantValue; value: VariantValue }> = []
      while (tokens.peek().value !== "}" || tokens.peek().kind !== "symbol") {
        const key = value(depth + 1); tokens.expect(":")
        entries.push({ key, value: value(depth + 1) })
        if (entries.length > 1_000_000) tokens.fail("Resource dictionary exceeds the safety limit")
        if (tokens.peek().value === "}" && tokens.peek().kind === "symbol") break
        tokens.expect(",")
      }
      tokens.expect("}")
      return make("dictionary", VARIANT.DICTIONARY, entries)
    }
    if (token.kind !== "word") tokens.fail("Expected a Variant value", token)
    const word = token.value
    if (word === "null") return make("nil", VARIANT.NIL, null)
    if (word === "true" || word === "false") return make("bool", VARIANT.BOOL, word === "true")
    if (/^[+-]?\d+$/.test(word)) {
      const integer = BigInt(word)
      if (integer >= -2147483648n && integer <= 2147483647n) return make("int", VARIANT.INT, Number(integer))
      if (integer < -9223372036854775808n || integer > 9223372036854775807n) tokens.fail("Integer exceeds int64 range", token)
      return make("int64", VARIANT.INT64, integer.toString())
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(word)) return make("double", VARIANT.DOUBLE, Number(word))
    if (["inf", "-inf", "nan"].includes(word)) return make("double", VARIANT.DOUBLE, word === "nan" ? NaN : word === "inf" ? Infinity : -Infinity)
    if (word === "&" || word === "^") {
      const string = tokens.next()
      if (string.kind !== "string") tokens.fail("Expected a quoted StringName or NodePath", string)
      return word === "&" ? make("string_name", VARIANT.STRING_NAME, string.value) : nodePath(string.value)
    }
    if ((word === "Array" || word === "Dictionary") && tokens.peek().value === "[") {
      // Typed collection annotations are retained byte-for-byte when not edited.
      tokens.next()
      let nesting = 1
      while (nesting) {
        const t = tokens.next()
        if (t.kind === "eof") tokens.fail("Unterminated typed collection annotation")
        if (t.kind === "symbol" && t.value === "[") nesting++
        if (t.kind === "symbol" && t.value === "]") nesting--
      }
    }
    tokens.expect("(")
    const args = sequence(")", depth)
    if (word === "Array" || word === "Dictionary") {
      if (args.length !== 1 || args[0]!.type !== word.toLowerCase()) tokens.fail("Invalid typed collection")
      return args[0]!
    }
    if (word === "ExtResource" || word === "SubResource") {
      if (args.length !== 1 || !["string", "int"].includes(args[0]!.type)) tokens.fail("Invalid resource reference")
      const id = String(args[0]!.value)
      const index = (word === "ExtResource" ? context.externalIds : context.internalIds).get(id)
      if (index === undefined) tokens.fail("Unresolved resource reference")
      return make("object", VARIANT.OBJECT, word === "ExtResource" ? { kind: "external_resource_index", index, resource: context.externalResources[index] } : { kind: "internal_resource", index })
    }
    if (word === "NodePath") {
      if (args.length !== 1 || args[0]!.type !== "string") tokens.fail("Invalid NodePath")
      return nodePath(args[0]!.value as string)
    }
    const spec = constructors[word]
    // Preserve opaque parameter values in read/diff output; edits fail closed.
    if (!spec) return make("opaque", -1, raw)
    const [type, id, size] = spec
    if (type === "callable" || type === "signal") return args.length === 0 ? make(type, id, null) : make("opaque", -1, raw)
    if (type === "string_name") {
      if (args.length !== 1 || args[0]!.type !== "string") tokens.fail("Invalid StringName")
      return make(type, id, args[0]!.value)
    }
    if (type === "string_array") {
      if (args.some(a => a.type !== "string")) tokens.fail("Invalid packed String array")
      return make(type, id, args.map(a => a.value))
    }
    if (type === "raw_array" && args.length === 1 && args[0]!.type === "string") return make(type, id, new Uint8Array(Buffer.from(args[0]!.value as string, "base64")))
    if (args.some(a => !["int", "int64", "double"].includes(a.type))) tokens.fail("Expected numeric constructor values")
    if (type === "int64_array") return make(type, id, args.map(a => String(a.value)))
    const values = args.map(a => Number(a.value))
    const rounded = type === "color" || type === "color_array" || type === "real_array" ? values.map(Math.fround) : values
    if (type === "raw_array") return make(type, id, new Uint8Array(values))
    if (type.endsWith("_array") && size) {
      if (values.length % size) tokens.fail("Invalid packed tuple array")
      return make(type, id, Array.from({ length: values.length / size }, (_, i) => rounded.slice(i * size, (i + 1) * size)))
    }
    if (size && values.length !== size) tokens.fail("Invalid constructor arity")
    return make(type, id, rounded)
  }
  function nodePath(text: string): VariantValue {
    const [names, ...subnames] = text.split(":")
    return make("node_path", VARIANT.NODE_PATH, { absolute: names!.startsWith("/"), names: names!.split("/").filter(Boolean), subnames })
  }
  const result = value(0)
  if (tokens.peek().kind !== "eof") tokens.fail("Trailing Variant data")
  return result
}

export function encodeTextVariant(variant: VariantValue, major: number): string {
  const value = variant.value
  const float = (v: number) => { const s = Object.is(v, -0) ? "-0.0" : String(v); return /[.eE]/.test(s) ? s : s + ".0" }
  if (variant.type === "nil") return "null"
  if (variant.type === "bool" || variant.type === "int" || variant.type === "int64") return String(value)
  if (variant.type === "real" || variant.type === "double") return float(value as number)
  if (variant.type === "string") return JSON.stringify(value)
  if (variant.type === "string_name") return "&" + JSON.stringify(value)
  const names: Record<string, string> = { vector2: "Vector2", rect2: "Rect2", vector3: "Vector3", vector4: "Vector4", vector2i: "Vector2i", rect2i: "Rect2i", vector3i: "Vector3i", vector4i: "Vector4i", plane: "Plane", quat: major === 4 ? "Quaternion" : "Quat", aabb: "AABB", basis: "Basis", transform: major === 4 ? "Transform3D" : "Transform", transform2d: "Transform2D", projection: "Projection", color: "Color", raw_array: major === 4 ? "PackedByteArray" : "PoolByteArray", int_array: major === 4 ? "PackedInt32Array" : "PoolIntArray", int64_array: "PackedInt64Array", real_array: major === 4 ? "PackedFloat32Array" : "PoolRealArray", double_array: "PackedFloat64Array", string_array: major === 4 ? "PackedStringArray" : "PoolStringArray", vector2_array: major === 4 ? "PackedVector2Array" : "PoolVector2Array", vector3_array: major === 4 ? "PackedVector3Array" : "PoolVector3Array", vector4_array: "PackedVector4Array", color_array: major === 4 ? "PackedColorArray" : "PoolColorArray" }
  const name = names[variant.type]
  if (!name) throw new GodotReaderError("INVALID_PATCH", `Cannot edit text Variant ${variant.type}`)
  const values = value instanceof Uint8Array ? Array.from(value) : (value as unknown[]).flat()
  return name + "(" + values.map(v => typeof v === "string" && variant.type === "string_array" ? JSON.stringify(v) : Object.is(v, -0) ? "-0.0" : String(v)).join(", ") + ")"
}
