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
          if (ch === "u") {
            const hex = this.text.slice(this.position, this.position + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              this.fail("Malformed Unicode escape in String", { ...start, kind: "string", value: "" })
            }
            this.position += 4
            ch = String.fromCharCode(parseInt(hex, 16))
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

export function inspectTextShader(text: string): { code: string; start: number; end: number } {
  const tokens = new Tokens(text)
  const header = readTag(tokens)
  if (header.name !== "gd_resource") tokens.fail("Expected a gd_resource header")
  const type = header.attributes.get("type")
  if (type?.kind !== "string" || type.value !== "Shader") {
    throw new GodotReaderError("NOT_SHADER_RESOURCE", "Text resource root must be Shader", {
      details: { resource_type: type?.value },
    })
  }
  const format = header.attributes.get("format")
  if (format?.kind !== "word" || format.value !== "2") {
    throw new GodotReaderError("UNSUPPORTED_RESOURCE_VERSION", "Only Godot 3 text resource format=2 is supported")
  }
  let section = ""
  let rootSeen = false
  let start = -1
  let end = -1
  let code: string | undefined
  while (tokens.peek().kind !== "eof") {
    if (isSymbol(tokens.peek(), "[")) {
      const tag = readTag(tokens)
      if (rootSeen || !["resource", "sub_resource", "ext_resource"].includes(tag.name)) {
        tokens.fail("Unexpected resource section")
      }
      section = tag.name
      if (section === "resource") rootSeen = true
      continue
    }
    const property = tokens.next()
    if (property.kind !== "word" && property.kind !== "string") tokens.fail("Expected a property name", property)
    if (section !== "resource" && section !== "sub_resource") tokens.fail("Property outside a resource section", property)
    tokens.expect("=")
    if (section === "resource" && property.value === "code") {
      if (code !== undefined) tokens.fail("Duplicate root Shader.code", property)
      const value = tokens.next()
      if (value.kind !== "string") {
        throw new GodotReaderError("SHADER_CODE_NOT_STRING", "Shader.code must be a String", { line: value.line })
      }
      code = value.value
      start = value.offset
      end = value.end!
    } else skipValue(tokens)
  }
  if (code === undefined || code.length === 0) {
    throw new GodotReaderError("SHADER_CODE_NOT_FOUND", "Root Shader has no non-empty code property")
  }
  return { code, start, end }
}

export function decodeShaderUtf8(bytes: Uint8Array, preserveBom = false): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom }).decode(bytes)
  } catch (cause) {
    throw new GodotReaderError("INVALID_UTF8", "Shader text is not valid UTF-8", { cause })
  }
}
