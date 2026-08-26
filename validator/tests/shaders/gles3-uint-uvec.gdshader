shader_type spatial;

void fragment() {
	uint value = 1u;
	uvec3 color = uvec3(value, 2u, 3u);
	ALBEDO = vec3(color) / 3.0;
}
