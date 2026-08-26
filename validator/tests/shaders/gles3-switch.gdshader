shader_type spatial;

void fragment() {
	int value = 2;
	vec3 color;
	switch (value) {
		case 1:
			color = vec3(1.0);
			break;
		case 2:
			color = vec3(0.5);
			break;
		default:
			color = vec3(0.0);
			break;
	}
	ALBEDO = color;
}
