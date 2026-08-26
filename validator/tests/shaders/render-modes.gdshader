shader_type spatial;
render_mode blend_add, depth_draw_alpha_prepass, cull_disabled;

void fragment() {
	ALBEDO = vec3(0.5);
	ALPHA = 0.5;
}
