import os
import sys

import bpy


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def parse_args():
    if "--" not in sys.argv:
        fail("Expected Blender arguments after --: <input.stl> <output.glb>")
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) != 2:
        fail("Expected Blender arguments after --: <input.stl> <output.glb>")
    return args[0], args[1]


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def import_stl(input_path):
    if hasattr(bpy.ops.wm, "stl_import"):
        bpy.ops.wm.stl_import(filepath=input_path)
    elif hasattr(bpy.ops.import_mesh, "stl"):
        bpy.ops.import_mesh.stl(filepath=input_path)
    else:
        fail("This Blender install does not include an STL importer.")


def apply_default_material():
    material = bpy.data.materials.new("CAD neutral material")
    material.diffuse_color = (0.72, 0.74, 0.78, 1.0)
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and not obj.data.materials:
            obj.data.materials.append(material)


def export_glb(output_path):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        export_yup=True,
    )


def main():
    input_path, output_path = parse_args()
    if not os.path.isfile(input_path):
        fail(f"STL input does not exist: {input_path}")

    reset_scene()
    import_stl(input_path)
    if not any(obj.type == "MESH" for obj in bpy.context.scene.objects):
        fail("STL import did not create any mesh objects.")
    apply_default_material()
    export_glb(output_path)


if __name__ == "__main__":
    main()
