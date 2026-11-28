"""Fall-asleep and wake transitions built from registered Mido poses."""

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from dog_local_motion import PoseMotion, ease

# Hair, ear edges, eyes, muzzle, planted paws, shoulder, hip and tail.
# Points are in the native 640 x 360 video coordinates.
LANDMARKS = {
    "sit": (
        (322, 24), (196, 110), (225, 146), (438, 81), (412, 119), (278, 111), (360, 104), (321, 130),
        (319, 157), (321, 184), (277, 298), (365, 299), (251, 246), (401, 250), (386, 294), (414, 220),
    ),
    "drowsy": (
        (321, 24), (199, 108), (227, 146), (431, 76), (411, 116), (277, 118), (354, 106), (317, 126),
        (318, 151), (320, 184), (288, 299), (359, 300), (251, 249), (399, 242), (388, 293), (416, 222),
    ),
    "lowering": (
        (301, 52), (203, 146), (233, 178), (406, 104), (388, 135), (267, 145), (334, 128), (302, 148),
        (304, 169), (298, 194), (266, 300), (346, 303), (264, 236), (415, 237), (435, 297), (462, 211),
    ),
    "kneeling": (
        (291, 71), (182, 168), (207, 204), (378, 99), (368, 143), (254, 177), (317, 152), (289, 179),
        (285, 197), (279, 220), (235, 293), (317, 300), (264, 243), (424, 224), (441, 288), (479, 209),
    ),
    "chin_down": (
        (235, 125), (172, 232), (184, 292), (353, 159), (346, 184), (246, 247), (308, 206), (287, 243),
        (278, 259), (266, 275), (237, 294), (312, 298), (302, 275), (433, 238), (440, 291), (481, 232),
    ),
    "lift_head": (
        (271, 102), (176, 179), (212, 236), (377, 129), (366, 182), (243, 202), (309, 176), (281, 205),
        (275, 226), (272, 251), (243, 292), (309, 299), (268, 268), (434, 244), (457, 289), (500, 225),
    ),
    "sleep": (
        (244, 128), (153, 270), (192, 299), (354, 144), (338, 191), (233, 255), (299, 203), (277, 247),
        (266, 270), (255, 289), (249, 299), (321, 303), (303, 276), (481, 242), (472, 298), (480, 276),
    ),
}
BOUNDARY = [(0, 0), (320, 0), (640, 0), (0, 170), (640, 170), (0, 360), (190, 360), (450, 360), (640, 360)]

def radial(squared_distance):
    return squared_distance * np.log(np.maximum(squared_distance, 1e-10))


def distances(left, right):
    return ((left[:, None, :] - right[None, :, :]) ** 2).sum(axis=2)


def map_point_cloud(query, basis, delta):
    size = len(basis)
    affine = np.column_stack((np.ones(size), basis))
    a = np.block([[radial(distances(basis, basis)) + 0.00001 * np.eye(size), affine],
                  [affine.T, np.zeros((3, 3))]])
    transform = np.linalg.solve(a, np.concatenate((delta, np.zeros((3, 2)))))
    values = np.column_stack((radial(distances(query, basis)), np.ones(len(query)), query))
    return values @ transform


def warp(image, source, target):
    width, height = image.size
    step = 8
    x, y = np.meshgrid(np.arange(0, width + 1, step), np.arange(0, height + 1, step))
    query = np.column_stack((x.ravel(), y.ravel())) / width
    delta = map_point_cloud(query, target / width, source - target)
    u = x + delta[:, 0].reshape(x.shape)
    v = y + delta[:, 1].reshape(y.shape)
    mesh = []
    for row, col in np.ndindex(y.shape[0] - 1, x.shape[1] - 1):
        corners = ((row, col), (row + 1, col), (row + 1, col + 1), (row, col + 1))
        quad = tuple(float(field[r, c]) for r, c in corners for field in (u, v))
        box = (col * step, row * step, (col + 1) * step, (row + 1) * step)
        mesh.append((box, quad))
    return image.transform(image.size, Image.Transform.MESH, mesh, Image.Resampling.BICUBIC)


def field_distance(alpha):
    mask = np.uint8(alpha >= 0.5)
    inside = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
    outside = cv2.distanceTransform(1 - mask, cv2.DIST_L2, 3)
    return inside - outside


def relax_sitting_face(plate, amount):
    """Let eyelids and smile close before they meet the drowsy key pose."""
    motion = PoseMotion(plate)
    motion.move((277, 111), (37, 29), scale_y=-0.61 * amount, y=3.0 * amount)
    motion.move((359, 104), (38, 29), scale_y=-0.61 * amount, y=3.0 * amount)
    motion.move((319, 165), (45, 25), scale_y=-0.64 * amount, y=-3.5 * amount)
    return motion.draw()


def mix_registered(plate_a, plate_b, key_a, key_b, progress):
    if progress <= 0:
        return plate_a
    if progress >= 1:
        return plate_b
    source = np.array(list(LANDMARKS[key_a]) + BOUNDARY, dtype=float)
    next_pose = np.array(list(LANDMARKS[key_b]) + BOUNDARY, dtype=float)
    dest = (1 - progress) * source + progress * next_pose
    if key_a == "sit" and key_b == "drowsy":
        plate_a = relax_sitting_face(plate_a, ease(progress / 0.62))
    if key_a == "drowsy" and key_b == "sit":
        plate_b = relax_sitting_face(plate_b, ease((1 - progress) / 0.62))
    first = np.array(warp(plate_a, source, dest), dtype=np.float32) / 255
    second = np.array(warp(plate_b, next_pose, dest), dtype=np.float32) / 255
    first_alpha = first[..., 3]
    second_alpha = second[..., 3]
    distance = (1 - progress) * field_distance(first_alpha) + progress * field_distance(second_alpha)
    alpha = np.minimum((0.5 + distance).clip(0, 1), np.maximum(first_alpha, second_alpha))
    first_weight = (1 - progress) * first_alpha
    second_weight = progress * second_alpha
    mismatch = np.max(np.abs(first[..., :3] - second[..., :3]), axis=2)
    # Keep distinct facial and paw details from one pose, but let compatible fur blend.
    strength = np.clip((mismatch - 0.09) / 0.38, 0, 1)
    harder = np.clip(0.5 + (second_weight - first_weight) * 4.5, 0, 1)
    softer = second_weight / np.maximum(first_weight + second_weight, 0.00001)
    weight = softer * (1 - strength) + harder * strength
    # At an uncovered edge, sample only the frame that owns the visible fur.
    weight = np.where(first_alpha < 0.10, 1.0, np.where(second_alpha < 0.10, 0.0, weight))
    rgb = (1 - weight[..., None]) * first[..., :3] + weight[..., None] * second[..., :3]
    pixels = np.concatenate((rgb, alpha[..., None]), axis=2)
    return Image.fromarray(np.uint8(np.rint(pixels.clip(0, 1) * 255)))


def yawn(pose, index, yawn_plate):
    if not 48 < index < 62:
        return pose
    amount = ease((index - 48) / 6) * ease((62 - index) / 5)
    if amount < 0.01:
        return pose
    motion = PoseMotion(pose)
    motion.move((278, 118), (27, 24), scale_y=-0.54 * amount, y=3 * amount)
    motion.move((354, 106), (27, 23), scale_y=-0.54 * amount, y=3 * amount)
    # Reuse the real yawn mouth, attached to the muzzle throughout the opening.
    patch = yawn_plate.crop((293, 130, 350, 183)).resize((53, round(12 + 41 * amount)), Image.Resampling.LANCZOS)
    mask = Image.new("L", patch.size)
    ImageDraw.Draw(mask).ellipse((4, 2, 49, patch.height - 2), fill=round(255 * min(1, amount * 1.75)))
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    pose = motion.draw().copy()
    pose.paste(patch, (294, round(142 - 7 * amount)), mask)
    return pose

ENTRY = ((0, "sit"), (11, "drowsy"), (23, "lowering"), (36, "kneeling"), (51, "chin_down"), (61, "sleep"), (67, "sleep"))
WAKE = ((0, "sleep"), (5, "sleep"), (14, "chin_down"), (23, "lift_head"), (31, "kneeling"),
        (41, "lowering"), (50, "drowsy"), (60, "drowsy"), (67, "sit"))


def render_transition(bank, master_dir, *, waking, shadow):
    """Render 68 frames and use the sleep loop's neutral pose where the clips meet."""
    plates = {name: bank.plate(name) for name in ("sit", "drowsy", "sleep")}
    for index, name in enumerate(("lowering", "kneeling", "chin_down", "lift_head"), 1):
        with Image.open(master_dir / f"sleep-step-{index}.png") as image:
            plates[name] = image.convert("RGBA")
    if waking:
        yawn_plate = bank.plate("yawn")
    keys = WAKE if waking else ENTRY
    frames = []
    for (first_frame, start), (last_frame, end) in zip(keys, keys[1:]):
        start_width = 1.15 if start in ("chin_down", "sleep") else 1.0
        end_width = 1.15 if end in ("chin_down", "sleep") else 1.0
        for index in range(first_frame, last_frame):
            position = (index - first_frame) / (last_frame - first_frame)
            amount = (position + ease(position)) / 2
            pose = plates[start] if start == end else mix_registered(
                plates[start], plates[end], start, end, amount
            )
            if waking:
                pose = yawn(pose, index, yawn_plate)
            frames.append(shadow(pose, 0, width_scale=start_width + (end_width - start_width) * amount))
    final_pose = keys[-1][1]
    frames.append(shadow(plates[final_pose], 0, width_scale=1.15 if final_pose == "sleep" else 1.0))
    return frames
