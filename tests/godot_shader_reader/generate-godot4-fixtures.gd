extends SceneTree

# Run with Godot 4.5.1 --headless --path <project> --script <this file>.
func _initialize() -> void:
	var destination := OS.get_cmdline_user_args()[0].replace("\\", "/")
	var shader := Shader.new()
	shader.code = "shader_type spatial;\nuniform vec4 tint : source_color = vec4(1.0);\nvoid fragment() { ALBEDO = tint.rgb; }\n"
	var material := ShaderMaterial.new()
	material.shader = shader
	material.set_shader_parameter("tint", Color(0.2, 0.4, 0.6, 1.0))
	material.set_meta("types", [Vector2i(-1, 2), Rect2i(1, 2, 3, 4), Vector3i(1, 2, 3), Vector4(1, 2, 3, 4), Vector4i(4, 3, 2, 1), Projection.IDENTITY, &"name", NodePath("node:property"), PackedInt64Array([9223372036854775807, -9223372036854775807]), PackedFloat64Array([1.123456789]), PackedVector4Array([Vector4(1, 2, 3, 4)]), Callable(), Signal()])
	for extension in ["res", "tres"]:
		print(ResourceSaver.save(material, destination.path_join("embedded." + extension)))
	print(ResourceSaver.save(material, destination.path_join("compressed.res"), ResourceSaver.FLAG_COMPRESS))
	print(ResourceSaver.save(shader, destination.path_join("standalone.res")))
	print(ResourceSaver.save(shader, destination.path_join("standalone.tres")))
	print(ResourceSaver.save(shader, destination.path_join("external.gdshader"), ResourceSaver.FLAG_CHANGE_PATH))
	shader.take_over_path("res://external.gdshader")
	print(ResourceSaver.save(material, destination.path_join("external.res"), ResourceSaver.FLAG_RELATIVE_PATHS))
	print(ResourceSaver.save(material, destination.path_join("external.tres"), ResourceSaver.FLAG_RELATIVE_PATHS))
	quit()
