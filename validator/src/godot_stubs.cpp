#include "core/error_macros.h"
#include "core/input_map.h"
#include "core/os/input.h"
#include "core/print_string.h"
#include "core/ustring.h"
#include "servers/audio_server.h"

#include <cstdio>

void (*_print_func)(String) = nullptr;
bool _print_line_enabled = false;
bool _print_error_enabled = false;

void add_error_handler(ErrorHandlerList *) {}
void remove_error_handler(ErrorHandlerList *) {}

void _err_print_error(const char *, const char *, int, const char *, ErrorHandlerType) {}
void _err_print_error(const char *, const char *, int, const String &, ErrorHandlerType) {}
void _err_print_error(const char *, const char *, int, const char *, const char *, ErrorHandlerType) {}
void _err_print_error(const char *, const char *, int, const String &, const char *, ErrorHandlerType) {}
void _err_print_error(const char *, const char *, int, const char *, const String &, ErrorHandlerType) {}
void _err_print_error(const char *, const char *, int, const String &, const String &, ErrorHandlerType) {}
void _err_print_index_error(const char *, const char *, int, int64_t, int64_t, const char *, const char *, const char *, bool) {}
void _err_print_index_error(const char *, const char *, int, int64_t, int64_t, const char *, const char *, const String &, bool) {}
void _err_flush_stdout() { std::fflush(stdout); }
void _physics_interpolation_warning(const char *, const char *, int, ObjectID, const char *) {}

void add_print_handler(PrintHandlerList *) {}
void remove_print_handler(PrintHandlerList *) {}
void print_line(String) {}
void print_error(String) {}
void print_verbose(String) {}

// These two implementations are copied verbatim from Godot 3.6 main/input_default.cpp.
// Core takes their addresses for ClassDB even though the validator never initializes Input.
float Input::get_axis(const StringName &p_negative_action, const StringName &p_positive_action) const {
	return get_action_strength(p_positive_action) - get_action_strength(p_negative_action);
}

Vector2 Input::get_vector(const StringName &p_negative_x, const StringName &p_positive_x, const StringName &p_negative_y, const StringName &p_positive_y, float p_deadzone) const {
	Vector2 vector = Vector2(
			get_action_raw_strength(p_positive_x) - get_action_raw_strength(p_negative_x),
			get_action_raw_strength(p_positive_y) - get_action_raw_strength(p_negative_y));

	if (p_deadzone < 0.0f) {
		p_deadzone = 0.25 *
				(InputMap::get_singleton()->action_get_deadzone(p_positive_x) +
						InputMap::get_singleton()->action_get_deadzone(p_negative_x) +
						InputMap::get_singleton()->action_get_deadzone(p_positive_y) +
						InputMap::get_singleton()->action_get_deadzone(p_negative_y));
	}

	float length = vector.length();
	if (length <= p_deadzone) {
		return Vector2();
	} else if (length > 1.0f) {
		return vector / length;
	}
	return vector * (Math::inverse_lerp(p_deadzone, 1.0f, length) / length);
}

// OS exposes these server symbols from one translation unit. They are unreachable in
// this process, but COFF keeps their references. Returning no drivers avoids linking
// AudioServer while preserving a fail-safe value if they are ever called accidentally.
int AudioDriverManager::get_driver_count() {
	return 0;
}

AudioDriver *AudioDriverManager::get_driver(int) {
	return nullptr;
}
