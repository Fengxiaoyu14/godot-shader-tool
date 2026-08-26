shader_type spatial;

const float VALUES[3] = { 0.1, 0.2, 0.3 };

void fragment() {
	float local_values[2] = { VALUES[0], VALUES[1] };
	ALBEDO = vec3(local_values[1]);
}
