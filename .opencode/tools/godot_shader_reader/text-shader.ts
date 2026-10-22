import { GodotReaderError } from "./errors.ts"

interface Token {
  kind: "string" | "word" | "symbol" | "eof"
  value: string
  offset: number
  line: number
  end?: number
}

// Godot 3.6 core/variant_parser.cpp, VariantParser::get_token.
// This reads resource structure and String values, not shader-language syntax.
class Tokens {
  private position = 0
  private line = 1
  private lookahead?: Token
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  peek(): Token {
    return this.lookahead ??= this.scan()
  }

  next(): Token {
    const token = this.peek()
    this.lookahead = undefined
    return token
  }

  expect(value: string): void {
    const token = this.next()
    if (token.kind !== "symbol" || token.value !== value) this.fail(`Expected ${value}`, token)
  }

  fail(message: string, token = this.peek()): never {
    throw new GodotReaderError("INVALID_TEXT_RESOURCE", message, {
      line: token.line,
      details: { character_offset: token.offset },
    })
  }

  private scan(): Token {
    while (this.position < this.text.length) {
      const c = this.text[this.position]!
      if (c === ";") {
        while (this.position < this.text.length && this.text[this.position] !== "\n") this.position++
      } else if (c <= " " || (this.position === 0 && c === "\uFEFF")) {
        if (c === "\n") this.line++
        this.position++
      } else break
    }
    const start = { offset: this.position, line: this.line }
    if (this.position === this.text.length) return { ...start, kind: "eof", value: "" }
    const c = this.text[this.position++]!
    if (c === '"') {
      const chars: string[] = []
      while (this.position < this.text.length) {
        let ch = this.text[this.position++]!
        if (ch === '"') return { ...start, kind: "string", value: chars.join(""), end: this.position }
        if (ch === "\0") this.fail("NUL in String", { ...start, kind: "string", value: "" })
        if (ch === "\\") {
          if (this.position === this.text.length) break
          ch = this.text[this.position++]!
          if (ch === "u" || ch === "U") {
            const size = ch === "U" ? 6 : 4
            const hex = this.text.slice(this.position, this.position + size)
            if (hex.length !== size || !/^[0-9a-fA-F]+$/.test(hex) || parseInt(hex, 16) > 0x10ffff) {
              this.fail("Malformed Unicode escape in String", { ...start, kind: "string", value: "" })
            }
            this.position += size
            ch = String.fromCodePoint(parseInt(hex, 16))
          } else {
            // Godot passes unknown escapes through, dropping the backslash.
            const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" }
            if (ch === "\n") this.line++
            ch = escapes[ch] ?? ch
          }
        } else if (ch === "\n") this.line++
        chars.push(ch)
      }
      this.fail("Unterminated String", { ...start, kind: "string", value: "" })
    }
    if ("[]{}()=,:".includes(c)) return { ...start, kind: "symbol", value: c }
    while (this.position < this.text.length && !/[\s\[\]{}()=,:";]/.test(this.text[this.position]!)) {
      this.position++
    }
    return { ...start, kind: "word", value: this.text.slice(start.offset, this.position) }
  }
}

function isSymbol(token: Token, symbol: string): boolean {
  return token.kind === "symbol" && token.value === symbol
}

// Consume one complete Variant, including nested metadata. Never search for
// `code =` in a string, subresource, dictionary, or comment.
function skipValue(tokens: Tokens, depth = 0): void {
  if (depth > 64) tokens.fail("Resource value nesting is too deep")
  const token = tokens.next()
  if (token.kind === "string") return
  if (token.kind === "word") {
    if ((token.value === "&" || token.value === "^") && tokens.peek().kind === "string") { tokens.next(); return }
    if (isSymbol(tokens.peek(), "[")) {
      tokens.next()
      skipSequence(tokens, "]", false, depth)
    }
    if (!isSymbol(tokens.peek(), "(")) return
    tokens.next()
    skipSequence(tokens, ")", false, depth)
    return
  }
  if (isSymbol(token, "[")) return skipSequence(tokens, "]", false, depth)
  if (isSymbol(token, "{")) return skipSequence(tokens, "}", true, depth)
  tokens.fail("Expected a resource property value", token)
}

function skipSequence(tokens: Tokens, end: string, dictionary: boolean, depth: number): void {
  while (!isSymbol(tokens.peek(), end)) {
    skipValue(tokens, depth + 1)
    if (dictionary) {
      tokens.expect(":")
      skipValue(tokens, depth + 1)
    }
    if (isSymbol(tokens.peek(), end)) break
    tokens.expect(",")
  }
  tokens.expect(end)
}

function readTag(tokens: Tokens): { name: string; attributes: Map<string, Token> } {
  tokens.expect("[")
  const name = tokens.next()
  if (name.kind !== "word") tokens.fail("Expected a resource section name", name)
  const attributes = new Map<string, Token>()
  while (!isSymbol(tokens.peek(), "]")) {
    const key = tokens.next()
    if (key.kind !== "word" || attributes.has(key.value)) tokens.fail("Invalid or duplicate tag attribute", key)
    tokens.expect("=")
    const value = tokens.peek()
    skipValue(tokens)
    attributes.set(key.value, value)
  }
  tokens.expect("]")
  return { name: name.value, attributes }
}

export function readTextShader(text: string): string {
  return inspectTextShader(text).code
}

export interface TextResourceInspection {
  type: "Shader" | "ShaderMaterial"
  formatVersion: number
  code?: string
  start?: number
  end?: number
  externalPath?: string
}

export function inspectTextResource(text: string): TextResourceInspection {
  const tokens = new Tokens(text)
  const header = readTag(tokens)
  if (header.name !== "gd_resource") tokens.fail("Expected a gd_resource header")
  const type = header.attributes.get("type")
  if (type?.kind !== "string" || !["Shader", "ShaderMaterial"].includes(type.value)) {
    throw new GodotReaderError("NOT_SHADER_RESOURCE", "Text resource root must be Shader or ShaderMaterial", {
      details: { resource_type: type?.value },
    })
  }
  const format = header.attributes.get("format")
  if (format?.kind !== "word" || !["2", "3", "4"].includes(format.value)) {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_VERSION", "Supported text resource formats are 2, 3 and 4")
  }
  const sections: Array<{ name: string; attributes: Map<string, Token>; properties: Map<string, Token> }> = []
  let current: typeof sections[number] | undefined
  let rootSeen = false
  while (tokens.peek().kind !== "eof") {
    if (isSymbol(tokens.peek(), "[")) {
      const tag = readTag(tokens)
      if (rootSeen || !["resource", "sub_resource", "ext_resource"].includes(tag.name)) tokens.fail("Unexpected resource section")
      if (tag.name === "resource") rootSeen = true
      current = { ...tag, properties: new Map() }
      sections.push(current)
      continue
    }
    const property = tokens.next()
    if (property.kind !== "word" && property.kind !== "string") tokens.fail("Expected a property name", property)
    if (!current || !["resource", "sub_resource"].includes(current.name)) tokens.fail("Property outside a resource section", property)
    if (current!.properties.has(property.value)) tokens.fail("Duplicate resource property", property)
    tokens.expect("=")
    const value = tokens.peek()
    if (property.value === "shader" && value.kind === "word" && ["SubResource", "ExtResource"].includes(value.value)) {
      tokens.next(); tokens.expect("(")
      const id = tokens.next()
      if (!["word", "string"].includes(id.kind)) tokens.fail("Invalid resource reference", id)
      tokens.expect(")")
      current!.properties.set(property.value, { ...id, kind: "word", value: value.value + ":" + id.value })
    } else {
      skipValue(tokens)
      current!.properties.set(property.value, value)
    }
  }
  const root = sections.find(s => s.name === "resource")
  if (!root) throw new GodotReaderError("SHADER_CODE_NOT_FOUND", "Missing root resource section")
  let shader = root
  if (type.value === "ShaderMaterial") {
    const reference = root!.properties.get("shader")?.value
    if (!reference) throw new GodotReaderError("SHADER_NOT_FOUND", "ShaderMaterial.shader is missing")
    const split = reference.indexOf(":")
    const kind = reference.slice(0, split), id = reference.slice(split + 1)
    const matches = sections.filter(s => s.name === (kind === "SubResource" ? "sub_resource" : "ext_resource") && s.attributes.get("id")?.value === id)
    if (!["SubResource", "ExtResource"].includes(kind) || matches.length !== 1) throw new GodotReaderError("SHADER_NOT_FOUND", "Shader reference cannot be resolved uniquely")
    shader = matches[0]
    if (shader!.attributes.get("type")?.value !== "Shader") throw new GodotReaderError("NOT_SHADER_RESOURCE", "Material reference must point to Shader")
    if (kind === "ExtResource") {
      const path = shader!.attributes.get("path")
      if (path?.kind !== "string") tokens.fail("External Shader requires a path")
      return { type: "ShaderMaterial", formatVersion: Number(format.value), externalPath: path!.value }
    }
  }
  const code = shader!.properties.get("code")
  if (code && code.kind !== "string") throw new GodotReaderError("SHADER_CODE_NOT_STRING", "Shader.code must be a String", { line: code.line })
  if (!code?.value.length) throw new GodotReaderError("SHADER_CODE_NOT_FOUND", "Shader has no non-empty code property")
  return { type: type.value as "Shader" | "ShaderMaterial", formatVersion: Number(format.value), code: code.value, start: code.offset, end: code.end! }
}

export function inspectTextShader(text: string): { code: string; start: number; end: number } {
  const header = readTag(new Tokens(text))
  if (header.name === "gd_resource" && header.attributes.get("type")?.value !== "Shader") throw new GodotReaderError("NOT_SHADER_RESOURCE", "Text resource root must be Shader")
  const inspected = inspectTextResource(text)
  if (inspected.type !== "Shader") throw new GodotReaderError("NOT_SHADER_RESOURCE", "Text resource root must be Shader")
  return { code: inspected.code!, start: inspected.start!, end: inspected.end! }
}

export function decodeShaderUtf8(bytes: Uint8Array, preserveBom = false): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom }).decode(bytes)
  } catch (cause) {
    throw new GodotReaderError("INVALID_UTF8", "Shader text is not valid UTF-8", { cause })
  }
}
