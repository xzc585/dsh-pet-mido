"""Local head, ear and jaw motion on the original balance artwork."""

import numpy as np
from PIL import Image

from dog_local_motion import ease, smoothstep

# Seconds are normalized to the clip, and offsets are native artwork pixels.
# Each path has its own intention and beat instead of a shared looping sine.
#                time  roll  horizontal vertical
PATHS = {
    "basket": ((0, 0, 0, 0), (.17, 5, 4, 6), (.40, -7, -3, -8),
               (.57, -5, -3, -7), (.72, -5, -3, -7), (.94, 1, 0, 0), (1, 0, 0, 0)),
    "bell": ((0, 0, 0, 0), (.17, -4, -2, 3), (.31, 6, 4, 9), (.47, -8, -3, -8),
             (.59, 5, 3, 1), (.72, -3, -1, 0), (.92, 0, 0, 0), (1, 0, 0, 0)),
    "bone": ((0, 0, 0, 0), (.20, -4, -3, -3), (.43, 8, 4, 5),
             (.61, 8, 4, 5), (.77, 5, 3, 2), (.96, 0, 0, 0), (1, 0, 0, 0)),
    "sniff": ((0, 0, 0, 0), (.14, -2, -5, 3), (.24, -4, -7, 8),
              (.34, -2, -4, 2), (.47, 1, 4, 5), (.57, 3, 8, 8),
              (.63, 2, 7, 3), (.73, 2, 5, 7), (.82, 1, 2, 2), (.98, 0, 0, 0), (1, 0, 0, 0)),
    "bowl": ((0, 0, 0, 0), (.22, 9, 6, 7), (.41, 8, 6, 7),
             (.61, -5, -5, -6), (.72, -6, -5, -5), (.94, 0, 0, 0), (1, 0, 0, 0)),
    "sad_bowl": ((0, 0, 0, 0), (.15, 0, 0, 1), (.42, -7, -3, 11),
                 (.64, -6, -3, 10), (.81, -4, -2, 8), (.98, 0, 0, 0), (1, 0, 0, 0)),
}

STEP = 8
X, Y = np.meshgrid(np.arange(0, 641, STEP), np.arange(0, 361, STEP))

# Hips, lower forelegs and the part of a stable prop next to the head may not
# follow the head warp. Regions are specified in the aligned 640x360 plates.
#        neck pivot   rigid through Y   stable below Y
ANCHORS = {
    "basket": (314, 188, 170, 231),
    "bell": (318, 194, 175, 249),
    "bone": (316, 196, 205, 255),
    "sniff": (330, 238, 274, 310),
    "bowl": (309, 184, 162, 235),
    "sad_bowl": (326, 202, 179, 237),
}

def sample_keys(pose, time):
    keys = PATHS[pose]
    for previous, upcoming in zip(keys, keys[1:]):
        if time >= upcoming[0]:
            continue
        ratio = ease((time - previous[0]) / (upcoming[0] - previous[0]))
        return tuple(a + (b - a) * ratio for a, b in zip(previous[1:], upcoming[1:]))
    return keys[-1][1:]


def fade(start, end, field):
    return smoothstep((field - start) / (end - start))


def render_balance_motion(plate, pose, time):
    roll, dx, dy = sample_keys(pose, time)
    delayed, _, _ = sample_keys(pose, max(0, time - 0.033))
    lag = (delayed - roll) * ease(min((1 - time) / 0.045, 1))
    if not any((roll, dx, dy, lag)):
        return plate.copy()
    pivot_x, pivot_y, finish_rigid, bottom = ANCHORS[pose]
    head = 1 - fade(finish_rigid, bottom, Y)
    if pose == "sniff":
        # The bowed head faces left. The neck leads the far front foot and then
        # releases into the planted paws; rear body and raised tail stay put.
        head *= 1 - fade(307, 374, X)
        head *= 1 - (1 - fade(221, 250, X)) * fade(279, 307, Y)
    else:
        # Tail/prop protection below the ear line leaves ears free above it.
        head *= 1 - fade(175, 211, Y) * fade(381, 411, X)
        if pose == "sad_bowl":
            head *= 1 - fade(185, 213, Y) * (1 - fade(236, 270, X))
    angle = np.radians(-roll * head)
    cosine, sine = np.cos(angle), np.sin(angle)
    xa, ya = X - pivot_x, Y - pivot_y
    source_x = pivot_x + cosine * xa - sine * ya - dx * head
    source_y = pivot_y + sine * xa + cosine * ya - dy * head
    if pose != "sniff":
        left_ear = np.exp(-((X - 213) / 29) ** 2 - ((Y - 124) / 32) ** 2)
        right_ear = np.exp(-((X - 425) / 26) ** 2 - ((Y - 113) / 32) ** 2)
        source_y += lag * (right_ear - left_ear) * head * 0.9

    mesh = []
    for row in range(Y.shape[0] - 1):
        for col in range(X.shape[1] - 1):
            box = (col * STEP, row * STEP, (col + 1) * STEP, (row + 1) * STEP)
            corners = ((row, col), (row + 1, col), (row + 1, col + 1), (row, col + 1))
            coords = tuple(field[i, j] for i, j in corners for field in (source_x, source_y))
            mesh.append((box, coords))
    return plate.transform(plate.size, Image.Transform.MESH, mesh, resample=Image.Resampling.BICUBIC)
