extends SceneTree

# Run in a disposable, minimal project. RendererDummy invokes the official
# ShaderCompiler/ShaderLanguage parser without a GPU or a user project script.
func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 1:
		quit(2)
		return
	var source := FileAccess.get_file_as_string(args[0])
	var shader := Shader.new()
	shader.code = source
	shader.get_shader_uniform_list()
	print("GODOT_SHADER_TYPE:" + ["spatial", "canvas_item", "particles", "sky", "fog"][shader.get_mode()])
	print("GODOT_SHADER_VALIDATION_COMPLETE:" + Engine.get_version_info().string)
	quit(0)
