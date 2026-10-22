import assert from "node:assert/strict"
import test from "node:test"
import { GodotReaderError } from "../../.opencode/tools/godot_shader_reader/errors.ts"
import { readTextShader } from "../../.opencode/tools/godot_shader_reader/text-shader.ts"

const header = '[gd_resource type="Shader" format=2]\n'
const resource = header + "[resource]\n"

test("text Shader preserves literal CRLF, Chinese, escaped quotes and backslashes", () => {
  const source = 'shader_type spatial;\r\n// 中文 "quoted" \\path\r\n'
  assert.equal(readTextShader(resource + 'code = "shader_type spatial;\r\n// 中文 \\"quoted\\" \\\\path\r\n"'), source)
  assert.equal(readTextShader("\uFEFF" + resource + `code = ${JSON.stringify(source)}`), source)
})

test("Godot String escape semantics include Unicode and unknown escape passthrough", () => {
  assert.equal(readTextShader(resource + String.raw`code = "\b\t\n\f\r\u4e2d\u6587\q\\\"\/"`), '\b\t\n\f\r中文q\\"/')
})

test("only the root code property is extracted, not comments, subresources, metadata or strings", () => {
  const text = header + `
; code = "comment"
[sub_resource type="Shader" id=1]
code = "subresource"
[resource]
metadata = { "code": "dictionary", "nested": [ "[resource]", { "key": "code = fake" } ] }
resource_name = "code = fake"
custom = Vector3(1, 2, 3)
code = "shader_type spatial;\n// [resource] and code = are shader text\n"
`
  assert.equal(readTextShader(text), "shader_type spatial;\n// [resource] and code = are shader text\n")
})

for (const [name, text, expected] of [
  ["wrong root type", resource.replace('type="Shader"', 'type="Texture"') + 'code = "x"', "NOT_SHADER_RESOURCE"],
  ["future format", resource.replace("format=2", "format=5") + 'code = "x"', "UNSUPPORTED_RESOURCE_VERSION"],
  ["wrong header", '[gd_scene format=2]\n[resource]\ncode="x"', "INVALID_TEXT_RESOURCE"],
  ["missing root code", resource + 'resource_name = "code=fake"', "SHADER_CODE_NOT_FOUND"],
  ["subresource-only code", header + '[sub_resource type="Shader" id=1]\ncode="fake"', "SHADER_CODE_NOT_FOUND"],
  ["empty code", resource + 'code=""', "SHADER_CODE_NOT_FOUND"],
  ["non-string code", resource + "code=123", "SHADER_CODE_NOT_STRING"],
  ["truncated string", resource + 'code="abc', "INVALID_TEXT_RESOURCE"],
  ["invalid Unicode escape", resource + String.raw`code="\u00QQ"`, "INVALID_TEXT_RESOURCE"],
  ["duplicate code", resource + 'code="a"\ncode="b"', "INVALID_TEXT_RESOURCE"],
  ["trailing garbage", resource + 'code="a" garbage', "INVALID_TEXT_RESOURCE"],
  ["duplicate root", resource + 'code="a"\n[resource]\ncode="b"', "INVALID_TEXT_RESOURCE"],
  ["unterminated nested metadata", resource + 'metadata = [1, 2\ncode="a"', "INVALID_TEXT_RESOURCE"],
] as const) {
  test(`text Shader rejects ${name}`, () => {
    assert.throws(() => readTextShader(text), (error: unknown) => error instanceof GodotReaderError && error.code === expected)
  })
}
