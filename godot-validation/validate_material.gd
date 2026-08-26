extends SceneTree

func _init():
	var material = load("res://output.material")
	if material == null:
		printerr("GODOT_VALIDATION_FAILED: load returned null")
		quit(1)
		return
	if not material is ShaderMaterial:
		printerr("GODOT_VALIDATION_FAILED: resource is not ShaderMaterial")
		quit(1)
		return
	if material.shader == null:
		printerr("GODOT_VALIDATION_FAILED: ShaderMaterial.shader is null")
		quit(1)
		return

	print("GODOT_VALIDATION_OK")
	quit(0)
