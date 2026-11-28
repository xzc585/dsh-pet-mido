"""Authored stretch with a seated handoff and separately articulated tail."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = (640, 360)
FPS = 24
FRAME_COUNT = 60
STEP = 6
X = np.r_[np.arange(0, SIZE[0], STEP), SIZE[0]]
Y = np.r_[np.arange(0, SIZE[1], STEP), SIZE[1]]
GRID = np.stack(np.meshgrid(X, Y), axis=-1).reshape(-1, 2) / 320
FENCE = [(0, 0), (160, 0), (320, 0), (480, 0), (640, 0),
         (0, 180), (640, 180), (0, 360), (160, 360), (320, 360),
         (480, 360), (640, 360)]
POSE_DATA = [
# brow tip and shape, then ears, eyes/nose/mouth/cheeks, forearms/paws,
 # elbows/hind hips, upper chest, and tail landmarks.
 (None, [
 (327,24),(247,58),(379,51),(242,74),(202,145),(211,92),
 (386,61),(425,115),(443,75),(279,111),(356,108),(316,130),(316,161),(319,184),(257,163),(391,151),
 (268,232),(368,235),(275,304),(365,305),(255,295),(386,303),
 (319,279),(398,258),(395,283),(281,192),(378,187),
 (426,218),(440,237),(434,263),(411,281),
 ]),
 ("stretch-neutral.png", [
 (313,22),(239,55),(361,35),(235,64),(220,130),(207,86),
 (366,45),(395,115),(419,77),
 (268,100),(339,92),(303,113),(303,147),(296,174),(237,144),(383,138),
 (265,227),(343,229),(266,302),(332,303),(241,290),(351,304),
 (309,276),(392,253),(389,291),(268,180),(362,177),
 (408,207),(431,220),(435,249),(413,271),
 ]),
 ("stretch-shallow.png", [
 (294,50),(224,84),(349,56),(215,92),(205,170),(191,125),
 (348,66),(375,124),(394,86),
 (252,132),(319,114),(287,146),(293,174),(281,195),(233,170),(370,150),
 (253,235),(325,236),(239,302),(301,304),(217,298),(325,301),
 (314,265),(414,218),(412,291),(254,201),(360,190),
 (401,143),(426,136),(447,160),(440,199),
 ]),
 ("stretch-forepaws.png", [
 (289,99),(219,129),(340,113),(206,145),(193,214),(174,177),
 (348,121),(374,192),(385,135),
 (233,180),(306,169),(263,200),(273,231),(259,253),(215,218),(368,209),
 (219,260),(327,265),(212,296),(273,305),(188,294),(295,304),
 (335,271),(430,184),(444,278),(231,252),(370,232),
 (344,82),(367,46),(407,65),(404,105),
 ]),
 ("stretch-bow.png", [
 (273,128),(213,156),(326,145),(198,166),(183,227),(167,194),
 (332,152),(369,221),(380,175),
 (221,196),(292,198),(247,218),(250,251),(241,270),(202,239),(350,238),
 (207,270),(307,275),(187,296),(247,305),(161,293),(275,305),
 (319,273),(434,183),(449,276),(210,267),(349,247),
 (351,66),(375,34),(414,52),(419,94),
 ]),
]

# Cut shapes isolate the tail as it passes behind the ear and rising hips.
TAIL_POLYGONS = [
    [(374, 123), (462, 121), (472, 166), (454, 213), (429, 206),
     (435, 184), (422, 165), (411, 159), (379, 156)],
    [(323, 27), (431, 23), (433, 79), (424, 117), (408, 113),
     (391, 106), (371, 103), (324, 108)],
]
TAIL_ROOTS = (442 + 197j, 404 + 106j)
TAIL_TIPS = (404 + 144j, 345 + 79j)


def _kernel(points, anchors):
    distance = np.sum((points[..., None, :] - anchors) ** 2, axis=-1)
    return .5 * distance * np.log(distance + 1e-8)


def _map(common, anchors):
    basis = np.column_stack((np.ones(len(common)), common))
    kernel = _kernel(common, common) + 4e-5 * np.eye(len(common))
    matrix = np.block([[kernel, basis], [basis.T, np.zeros((3, 3))]])
    coefficients = np.linalg.solve(matrix, np.concatenate((anchors, np.zeros((3, 2)))))
    vertices = np.column_stack((_kernel(GRID, common), np.ones(len(GRID)), GRID))
    return (vertices @ coefficients).reshape(len(Y), len(X), 2) * 320


def _warp(pose, mesh):
    tiles = [
        ((int(X[c]), int(Y[r]), int(X[c + 1]), int(Y[r + 1])),
         tuple(np.concatenate((mesh[r, c], mesh[r + 1, c], mesh[r + 1, c + 1], mesh[r, c + 1]))))
        for r in range(len(Y) - 1)
        for c in range(len(X) - 1)
    ]
    return np.asarray(pose.transform(SIZE, Image.Transform.MESH, tiles, Image.Resampling.BICUBIC),
                      dtype=np.float32)


def _mix(left, right, portion, cv2, *, tail=False):
    def signed_distance(alpha):
        inside = np.uint8(alpha >= 128)
        positive = cv2.distanceTransform(inside, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        negative = cv2.distanceTransform(1 - inside, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        if tail:
            return positive - negative
        return positive - negative + np.clip(alpha / 255 - inside, -.5, .5)

    a, b = left[..., 3], right[..., 3]
    wa, wb = (1 - portion) * a, portion * b
    total = wa + wb
    scale, edge_blend = (.55, 12) if tail else (.62, 16)
    field = (1 - portion) * signed_distance(a) + portion * signed_distance(b)
    single = np.clip(field * scale + .5, 0, 1) * 255
    mix = min(1, portion * edge_blend, (1 - portion) * edge_blend)
    alpha = single * mix + total * (1 - mix)
    color = (left[..., :3] * wa[..., None] + right[..., :3] * wb[..., None]) / np.maximum(
        total[..., None], 1e-4 if tail else 1e-6
    )
    return Image.fromarray(np.uint8(np.round(np.concatenate((color, alpha[..., None]), axis=-1))))


def _body(poses, anchors, portion, cv2):
    common = (1 - portion) * anchors[0] + portion * anchors[1]
    left = _warp(poses[0], _map(common, anchors[0]))
    right = _warp(poses[1], _map(common, anchors[1]))
    return _mix(left, right, portion, cv2)


def _split_tail(pose, polygon):
    selection = Image.new("L", SIZE)
    ImageDraw.Draw(selection).polygon(polygon, fill=255)
    weight = np.array(selection.filter(ImageFilter.GaussianBlur(2.4)), dtype=np.float32) / 255
    alpha = np.array(pose.getchannel("A"), dtype=np.float32) / 255
    tail_alpha = alpha * weight
    body_alpha = np.divide(alpha - tail_alpha, 1 - tail_alpha, out=np.zeros_like(alpha), where=tail_alpha < 1)
    tail, body = pose.copy(), pose.copy()
    tail.putalpha(Image.fromarray(np.uint8(np.round(tail_alpha * 255))))
    body.putalpha(Image.fromarray(np.uint8(np.round(body_alpha * 255))))
    return tail, body


def _tail_transform(pose, old_root, old_tip, root, tip):
    factor = (old_tip - old_root) / (tip - root)
    offset = old_root - root * factor
    inverse = (factor.real, -factor.imag, offset.real, factor.imag, factor.real, offset.imag)
    return np.asarray(pose.transform(SIZE, Image.Transform.AFFINE, inverse, Image.Resampling.BICUBIC),
                      dtype=np.float32)


def _progress(seconds):
    def ease(t):
        p = np.clip(t, 0, 1)
        return float(p * p * (3 - 2 * p))

    if seconds < .98:
        return 4 * ease((seconds - .04) / .94)
    if seconds < 1.48:
        return 4 - .095 * math.sin(math.pi * (seconds - .98) / .5) ** 2
    return 4 * (1 - ease((seconds - 1.48) / .91))


def render_stretch(bank, master_dir, *, shadow) -> list[Image.Image]:
    """Return the original 2.5-second action as 60 transparent frames."""
    import cv2

    poses = [bank.plate("sit")]
    for filename, _ in POSE_DATA[1:]:
        with Image.open(Path(master_dir) / filename) as source:
            poses.append(source.convert("RGBA"))
    anchors = [np.array(rows + FENCE, dtype=np.float64) / 320 for _, rows in POSE_DATA]
    tails, cores = zip(*(_split_tail(pose, polygon) for pose, polygon in zip(poses[2:4], TAIL_POLYGONS)))
    # Exclude tail controls and the two unstable, occluded chest anchors
    # from the mesh driving the body on the shallow-to-planted descent.
    body_controls = np.r_[np.delete(np.arange(27), [17, 22]), np.arange(31, 31 + len(FENCE))]
    shallow_anchors = [rows[body_controls] for rows in anchors[2:4]]
    neutral_anchors = [np.delete(rows, 24, axis=0) for rows in anchors[:2]]

    frames = []
    for index in range(FRAME_COUNT):
        progress = _progress(index / FPS)
        key = int(progress)
        portion = progress - key
        if portion == 0:
            plate = poses[key]
        elif key == 2:
            body = _body(cores, shallow_anchors, portion, cv2)
            root = (1 - portion) * TAIL_ROOTS[0] + portion * TAIL_ROOTS[1]
            tip = (1 - portion) * TAIL_TIPS[0] + portion * TAIL_TIPS[1]
            left, right = [_tail_transform(pose, rr, tt, root, tip)
                           for pose, rr, tt in zip(tails, TAIL_ROOTS, TAIL_TIPS)]
            plate = Image.alpha_composite(_mix(left, right, portion, cv2, tail=True), body)
        else:
            active_anchors = neutral_anchors if key == 0 else anchors[key:key + 2]
            plate = _body(poses[key:key + 2], active_anchors, portion, cv2)
        frames.append(shadow(plate, 0, width_scale=1 + .055 * progress))
    return frames
