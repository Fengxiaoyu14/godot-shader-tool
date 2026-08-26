#include "core/string_name.h"
#include "servers/visual/shader_language.h"
#include "servers/visual/shader_types.h"

#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>

namespace {

std::string json_escape(const std::string &value) {
	std::ostringstream out;
	for (unsigned char character : value) {
		switch (character) {
			case '"': out << "\\\""; break;
			case '\\': out << "\\\\"; break;
			case '\b': out << "\\b"; break;
			case '\f': out << "\\f"; break;
			case '\n': out << "\\n"; break;
			case '\r': out << "\\r"; break;
			case '\t': out << "\\t"; break;
			default:
				if (character < 0x20) {
					static const char digits[] = "0123456789abcdef";
					out << "\\u00" << digits[(character >> 4) & 0x0f] << digits[character & 0x0f];
				} else {
					out << static_cast<char>(character);
				}
		}
	}
	return out.str();
}

std::string to_utf8(const String &value) {
	const CharString encoded = value.utf8();
	return encoded.get_data() == nullptr ? std::string() : std::string(encoded.get_data());
}

void emit_internal_error(const char *code, const std::string &message) {
	std::cout << "{\"valid\":false,\"internal_error\":{\"code\":\"" << code
			  << "\",\"message\":\"" << json_escape(message) << "\"}}\n";
}

bool read_source(int argc, char **argv, std::string &source, std::string &error) {
	if (argc == 2 && std::string(argv[1]) == "--stdin") {
		source.assign(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
		if (std::cin.bad()) {
			error = "Could not read shader source from stdin";
			return false;
		}
		return true;
	}

	std::string file_path;
	if (argc == 3 && std::string(argv[1]) == "--file") {
		file_path = argv[2];
	} else if (argc == 2 && std::string(argv[1]).compare(0, 2, "--") != 0) {
		file_path = argv[1];
	} else {
		error = "Usage: godot-shader-validator --stdin | --file <shader-file> | <shader-file>";
		return false;
	}

	std::ifstream input(file_path, std::ios::binary);
	if (!input) {
		error = "Could not open shader source file: " + file_path;
		return false;
	}
	source.assign(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
	if (input.bad()) {
		error = "Could not read shader source file: " + file_path;
		return false;
	}
	return true;
}

VS::ShaderMode resolve_mode(const String &shader_type) {
	if (shader_type == "canvas_item") {
		return VS::SHADER_CANVAS_ITEM;
	}
	if (shader_type == "particles") {
		return VS::SHADER_PARTICLES;
	}
	return VS::SHADER_SPATIAL;
}

} // namespace

int main(int argc, char **argv) {
	std::string source;
	std::string input_error;
	if (!read_source(argc, argv, source, input_error)) {
		emit_internal_error("VALIDATOR_INPUT_ERROR", input_error);
		return 3;
	}

	String code;
	if (code.parse_utf8(source.data(), static_cast<int>(source.size()))) {
		emit_internal_error("VALIDATOR_INPUT_ERROR", "Shader source is not valid UTF-8");
		return 3;
	}

	StringName::setup_standalone();
	ShaderTypes shader_types;
	ShaderLanguage language;
	const String shader_type = ShaderLanguage::get_shader_type(code);
	const VS::ShaderMode mode = resolve_mode(shader_type);

	const Error result = language.compile(
			code,
			shader_types.get_functions(mode),
			shader_types.get_modes(mode),
			shader_types.get_types());

	const std::string type_utf8 = to_utf8(shader_type);
	if (result == OK) {
		std::cout << "{\"valid\":true,\"godot_version\":\"3.6\",\"renderer\":\"gles3\",\"shader_type\":\""
				  << json_escape(type_utf8) << "\"}\n";
		return 0;
	}
	if (result != ERR_PARSE_ERROR) {
		emit_internal_error(
				"VALIDATOR_INTERNAL_ERROR",
				"Godot ShaderLanguage returned unexpected error code " + std::to_string(static_cast<int>(result)));
		return 2;
	}

	std::cout << "{\"valid\":false,\"godot_version\":\"3.6\",\"renderer\":\"gles3\"";
	if (!type_utf8.empty()) {
		std::cout << ",\"shader_type\":\"" << json_escape(type_utf8) << "\"";
	}
	std::cout << ",\"error\":{\"line\":" << language.get_error_line()
			  << ",\"message\":\"" << json_escape(to_utf8(language.get_error_text())) << "\"}}\n";
	return 1;
}
