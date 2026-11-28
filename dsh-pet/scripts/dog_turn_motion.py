"""Seated look-around using Mido's authored left and right head poses."""

import numpy as np
from PIL import Image

from dog_local_motion import ease, smoothstep
from dog_sleep_motion import field_distance, warp

# Matched crown, ears, cheek outline, eyes, nose, mouth and upper neck in 640×360 coordinates.
HEAD_POINTS = {
    "sit": (
        (322, 24), (263, 45), (376, 37), (236, 65), (201, 90), (192, 107), (201, 131), (219, 148), (237, 139),
        (414, 52), (439, 75), (443, 97), (424, 122), (408, 114),
        (234, 158), (244, 173), (274, 185), (317, 192), (355, 186), (386, 171), (402, 153), (405, 130),
        (260, 119), (276, 95), (294, 111), (278, 113), (277, 128),
        (339, 102), (356, 88), (378, 104), (359, 103), (361, 118),
        (299, 131), (320, 117), (336, 126), (320, 140),
        (274, 148), (296, 154), (320, 153), (344, 148), (366, 136),
        (306, 166), (324, 170), (340, 163), (320, 176),
        (274, 193), (339, 191), (379, 189),
    ),
    "look_l": (
        (303, 24), (251, 44), (357, 39), (226, 63), (196, 90), (188, 106), (195, 126), (210, 137), (218, 125),
        (398, 52), (425, 72), (428, 100), (402, 132), (388, 122),
        (219, 152), (231, 166), (259, 181), (299, 190), (331, 184), (365, 171), (379, 151), (380, 129),
        (236, 113), (250, 89), (260, 103), (249, 105), (248, 119),
        (301, 102), (315, 88), (340, 105), (317, 104), (318, 118),
        (249, 129), (269, 113), (286, 124), (264, 137),
        (239, 143), (267, 151), (287, 151), (306, 148), (327, 142),
        (263, 166), (277, 166), (287, 158), (269, 174),
        (264, 190), (328, 189), (359, 188),
    ),
    "look_r": (
        (329, 23), (268, 46), (381, 35), (239, 56), (199, 80), (180, 111), (189, 132), (225, 151), (245, 140),
        (401, 48), (416, 58), (421, 83), (409, 110), (400, 102),
        (249, 156), (258, 172), (292, 183), (330, 187), (369, 178), (392, 159), (405, 142), (406, 126),
        (279, 122), (300, 92), (318, 106), (302, 109), (303, 124),
        (357, 96), (368, 80), (382, 90), (372, 93), (377, 107),
        (335, 127), (354, 109), (366, 120), (355, 135),
        (297, 145), (318, 151), (345, 147), (363, 140), (373, 134),
        (344, 162), (362, 169), (368, 157), (360, 174),
        (280, 191), (348, 186), (386, 184),
    ),
}
# Connect the donor shoulders to the seated torso, and pin the mesh outside the head area.
SHOULDERS = {
    "sit": ((262, 205), (382, 206), (257, 221), (388, 222)),
    "look_l": ((252, 204), (364, 206), (246, 221), (372, 222)),
    "look_r": ((266, 205), (389, 204), (261, 221), (393, 221)),
}
BOUNDARY = (
    (0, 0), (320, 0), (640, 0), (0, 140), (640, 140), (210, 214), (427, 211), (225, 240), (414, 240),
    (316, 219), (320, 260), (0, 360), (190, 360), (450, 360), (640, 360),
)

# 64 frames at 24 fps: look left, pause, look straight through to the right, then settle.
LOOK_KEYS = ((0, 0), (3, 0), (14, -1), (20, -1), (41, 1), (48, 1), (59, 0), (63, 0))


def registered_head(front, side, origin, destination, amount):
    """Align both poses before mixing their color and silhouette."""
    target = (1 - amount) * origin + amount * destination
    target[len(HEAD_POINTS["sit"]):] = origin[len(HEAD_POINTS["sit"]):]
    front = np.asarray(warp(front, origin, target), dtype=np.float32) / 255
    side = np.asarray(warp(side, destination, target), dtype=np.float32) / 255
    front_alpha = front[..., 3:]
    side_alpha = side[..., 3:]
    front_weight = (1 - amount) * front_alpha
    side_weight = amount * side_alpha
    color = (front[..., :3] * front_weight + side[..., :3] * side_weight) / np.maximum(front_weight + side_weight, 1e-6)
    distance = (1 - amount) * field_distance(front_alpha[..., 0]) + amount * field_distance(side_alpha[..., 0])
    alpha = np.minimum(np.maximum(front_alpha, side_alpha), (0.5 + distance[..., None]).clip(0, 1))
    return color, alpha


def render_turn(bank, *, shadow):
    """Leave the paws, ground shadow, torso and tail on the original seated pose."""
    plates = {key: bank.plate(key) for key in HEAD_POINTS}
    points = {key: np.array(head + SHOULDERS[key] + BOUNDARY, dtype=float) for key, head in HEAD_POINTS.items()}
    front = plates["sit"]
    neutral = np.asarray(front, dtype=np.float32) / 255
    neutral_alpha = neutral[..., 3:]
    neck = smoothstep((226 - np.arange(front.height, dtype=np.float32)) / 41)[:, None, None]
    rendered = {0: shadow(front, 0)}

    frames = []
    for (start, first), (end, last) in zip(LOOK_KEYS, LOOK_KEYS[1:]):
        for index in range(start, end):
            angle = first + (last - first) * ease((index - start) / (end - start))
            if angle not in rendered:
                key = "look_l" if angle < 0 else "look_r"
                color, alpha = registered_head(front, plates[key], points["sit"], points[key], abs(angle))
                head_weight = neck * alpha
                body_weight = (1 - neck) * neutral_alpha
                total = head_weight + body_weight
                rgb = (head_weight * color + body_weight * neutral[..., :3]) / np.maximum(total, 1e-6)
                pixels = np.concatenate((rgb, total), axis=2)
                pose = Image.fromarray(np.uint8(np.rint(pixels.clip(0, 1) * 255)))
                rendered[angle] = shadow(pose, 0)
            frames.append(rendered[angle])
    frames.append(rendered[0])
    return frames
