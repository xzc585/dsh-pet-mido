#!/usr/bin/env python3
"""用参照图与同一只狗的姿势底板生成米豆的透明 VP9 动画与立绘。

画风：毛茸茸的乳白/奶油色三维小狗（浅金耳朵、圆圆的棕色眼睛、棕色鼻子）。
禁止整只狗改透明度做转场；禁止把二维/像素道具贴纸贴到三维毛发上。
道具已画在生成的姿势底板里，与狗同一套光照。

依赖：Python 3、Pillow、numpy、opencv-python、ffmpeg（需 libvpx-vp9）。
"""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
import tempfile
from collections import deque
from functools import partial
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import dog_balance_motion
import dog_body_motion
import dog_gait_motion
import dog_local_motion
import dog_sleep_motion
import dog_stretch_motion

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(__file__).resolve().parent / "dog-source"
OUT_DIR = ROOT / "assets" / "pet-packs" / "dog"
ANIM_DIR = OUT_DIR / "dog-animation"
W, H = 640, 360
FPS = 12
# 只提高通过对照的循环片段帧率，同时取消片尾重复的起始帧。
LOCAL_MOTIONS = {
    "待机呼吸": dog_local_motion.idle,
    "转转头": dog_local_motion.turn,
    "碎碎念-歪头咕哝": dog_local_motion.whisper_tilt,
    "碎碎念-摇尾说话": dog_local_motion.whisper_talk,
    "工作状态-歪头思索": dog_local_motion.think,
    "工作状态-摇尾汇报": dog_local_motion.report,
    "工作状态-坐等": dog_local_motion.wait,
    "工作状态-垂耳失落": dog_local_motion.sad,
}
GAIT_MOTIONS = {"小步跑", "点击回应-摇尾欢跳", "工作状态-欢跳成功"}
BODY_MOTIONS = {"被抱起", "睡觉-循环"}
SLEEP_TRANSITIONS = {"睡觉-入睡": False, "睡觉-醒来": True}
BALANCE_MOTIONS = {
    "余额-骨头满篮": "basket",
    "余额-摇铃得意": "bell",
    "余额-叼着骨头": "bone",
    "余额-四处嗅寻": "sniff",
    "余额-空碗张望": "bowl",
    "余额-可怜巴巴": "sad_bowl",
}
DIG_MOTIONS = {"刨一刨", "工作状态-刨地忙碌"}
STRETCH_MOTION = "伸懒腰"
SMOOTH_LOOP_RATES = dict.fromkeys(
    (*LOCAL_MOTIONS, *GAIT_MOTIONS, *BODY_MOTIONS, *BALANCE_MOTIONS, *DIG_MOTIONS,
     *SLEEP_TRANSITIONS, STRETCH_MOTION, "摇尾巴", "坐下歪头"), 24
)
MOTION_MASTERS = SOURCE / "motion-masters"
GROUND = int(H * 0.88)

# 各姿势在画布上的目标高度（相对 H），脚底对齐 GROUND。
POSE_HEIGHT = {
    "sit": 0.84, "blink": 0.84, "drowsy": 0.84, "yawn": 0.84,
    "look_l": 0.84, "look_r": 0.84, "head_tilt": 0.84,
    "wag_l": 0.84, "wag_r": 0.84, "talk": 0.84, "think": 0.84,
    "basket": 0.84, "bell": 0.84, "bone": 0.84,
    "bowl": 0.84, "sad_bowl": 0.84, "sad": 0.84,
    "sleep": 0.58, "lie_mid": 0.58, "lie_start": 0.70,
    "hop": 0.80, "held": 0.62,
    "trot": 0.80, "trot2": 0.80, "spin_turn": 0.80,
    "side_l": 0.80, "side_r": 0.80, "rear": 0.80,
    "dig": 0.72, "sniff": 0.72,
    "stretch": 0.70, "stretch_mid": 0.72,
}


def _lum(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _is_cream(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return (lum > 70) & (r > 80) & (g > 60) & (r + g > b * 1.6)


def restore_reference_edge_color(image: np.ndarray) -> None:
    """Remove dark background color from the seated source's exterior fur."""
    import cv2

    alpha = image[..., 3].astype(np.float32) / 255
    rgb = image[..., :3].astype(np.float32)
    luminance = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    light = rgb @ luminance
    outside = np.pad((alpha < 0.04).astype(np.uint8), 1, constant_values=1)
    cv2.floodFill(outside, None, (0, 0), 2, flags=8)
    depth = cv2.distanceTransform((outside[1:-1, 1:-1] != 2).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    # These distances are in the 1024 px source. Only trust fully covered fur a few output pixels inward.
    inner_depth = 10
    anchor = (alpha >= 0.97) & (depth >= inner_depth)
    if not anchor.any():
        return

    gap, labels = cv2.distanceTransformWithLabels((~anchor).astype(np.uint8), cv2.DIST_L2, 5,
                                                   labelType=cv2.DIST_LABEL_PIXEL)
    mask = anchor.astype(np.float32)
    weighted_color = cv2.GaussianBlur(rgb * mask[..., None], (7, 7), 1.75)
    opacity = cv2.GaussianBlur(mask, (7, 7), 1.75)
    average_color = weighted_color / np.maximum(opacity, 0.001)[..., None]
    colors = np.zeros((labels.max() + 1, 3), dtype=np.float32)
    colors[labels[anchor]] = average_color[anchor]
    fur = colors[labels]
    fur_light = fur @ luminance
    smoothstep = dog_local_motion.smoothstep
    matte = smoothstep((fur_light - light - 9) / 46)
    rim = smoothstep((inner_depth + 5 - depth) / (inner_depth * 0.8))
    has_neighbor = smoothstep((inner_depth + 13 - gap) / (inner_depth * 0.8))
    weight = np.where((alpha > 0.017) & (fur_light > 60), 0.94 * rim * has_neighbor * matte, 0)
    image[..., :3] = np.rint(rgb + (fur - rgb) * weight[..., None]).astype(np.uint8)


def key_dark_background(im: Image.Image, luma_thr: float = 36.0, *, keep_low_nose: bool = False) -> Image.Image:
    im = im.convert("RGBA")
    arr = np.array(im)
    rgb = arr[..., :3].astype(np.float32)
    lum = _lum(rgb)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h, w = lum.shape
    cream = _is_cream(r, g, b)

    def looks_bg(y: int, x: int) -> bool:
        L = lum[y, x]
        if cream[y, x] and L > 55:
            return False
        if L < luma_thr:
            return True
        if L < 52 and max(rgb[y, x]) < 80 and not cream[y, x]:
            return True
        return False

    bg = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()
    border = []
    for x in range(w):
        border.append((0, x))
        border.append((h - 1, x))
    for y in range(h):
        border.append((y, 0))
        border.append((y, w - 1))
    for y, x in border:
        if looks_bg(y, x) and not bg[y, x]:
            bg[y, x] = True
            q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not bg[ny, nx] and looks_bg(ny, nx):
                bg[ny, nx] = True
                q.append((ny, nx))

    for _ in range(10):
        dil = np.zeros_like(bg)
        dil[1:, :] |= bg[:-1, :]
        dil[:-1, :] |= bg[1:, :]
        dil[:, 1:] |= bg[:, :-1]
        dil[:, :-1] |= bg[:, 1:]
        extra = dil & ~bg & ~cream & (lum < 64) & (np.max(rgb, axis=2) < 95)
        if not extra.any():
            break
        bg |= extra

    yy = np.arange(h)[:, None]
    paw_zone = (yy > h * 0.80) & (lum < 48) & ~cream
    near_bg = np.zeros_like(bg)
    near_bg[1:, :] |= bg[:-1, :]
    near_bg[:-1, :] |= bg[1:, :]
    near_bg[:, 1:] |= bg[:, :-1]
    near_bg[:, :-1] |= bg[:, 1:]
    bg |= paw_zone & (near_bg | bg)

    if keep_low_nose:
        # These two plates have a dark nose almost touching the ground. The
        # background flood would otherwise reach it through the mouth shadow.
        xx = np.arange(w)[None, :] * (640 / w)
        yy = yy * (640 / h)
        bg[((xx - 244) / 39)**2 + ((yy - 504) / 31)**2 <= 1] = False

    fg = ~bg
    mask = (fg.astype(np.uint8) * 255)
    solid = np.array(Image.fromarray(mask).filter(ImageFilter.MinFilter(3)))
    blur = np.array(Image.fromarray(mask).filter(ImageFilter.GaussianBlur(1.4))).astype(np.float32) / 255.0
    alpha = np.clip(np.maximum(solid.astype(np.float32) / 255.0, blur), 0, 1)
    edge = (alpha > 0.02) & (alpha < 0.95)
    dark_edge = edge & (lum < 40)
    alpha = alpha.copy()
    alpha[dark_edge] *= np.clip(lum[dark_edge] / 40.0, 0, 1)

    out = arr.copy()
    out[..., 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(out)


def clean_reference_alpha(im: Image.Image) -> Image.Image:
    arr = np.array(im.convert("RGBA"))
    rgb = arr[..., :3].astype(np.float32)
    alpha = arr[..., 3].astype(np.float32) / 255.0
    lum = _lum(rgb)
    h, w = lum.shape
    yy = np.arange(h)[:, None]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    cream = _is_cream(r, g, b)
    shadow = (alpha > 0.5) & (yy > h * 0.82) & (lum < 50) & ~cream
    alpha = alpha.copy()
    alpha[shadow] = 0
    mask = (alpha > 0.5).astype(np.uint8) * 255
    solid = np.array(Image.fromarray(mask).filter(ImageFilter.MinFilter(3)))
    blur = np.array(Image.fromarray(mask).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255.0
    fa = np.clip(np.maximum(solid.astype(np.float32) / 255.0, blur), 0, 1)
    trans = (fa < 0.08).astype(np.uint8) * 255
    near_t = np.array(Image.fromarray(trans).filter(ImageFilter.MaxFilter(5))) > 0
    edge = (fa > 0.08) & near_t
    fa = fa.copy()
    fa[edge] *= np.clip((lum[edge] / 70.0) ** 0.7, 0.15, 1.0)
    out = arr.copy()
    boost = np.clip(70.0 / np.maximum(lum, 1.0), 1.0, 1.8)
    for c in range(3):
        ch = out[..., c].astype(np.float32)
        ch[edge] = np.clip(ch[edge] * boost[edge], 0, 255)
        out[..., c] = ch.astype(np.uint8)
    out[..., 3] = (fa * 255).astype(np.uint8)
    restore_reference_edge_color(out)
    return Image.fromarray(out)


def load_pose(path: Path) -> Image.Image:
    im = Image.open(path)
    if path.suffix.lower() == ".png":
        im = im.convert("RGBA")
        a = np.array(im)
        if (a[..., 3] == 0).mean() > 0.2:
            return clean_reference_alpha(im)
    return key_dark_background(im, keep_low_nose=path.stem in ("mido-dig", "mido-sniff"))


def crop_transparent(im: Image.Image, pad: int = 8) -> Image.Image:
    a = np.array(im.split()[-1])
    ys, xs = np.where(a > 8)
    if len(xs) == 0:
        return im
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(im.width, x1 + pad)
    y1 = min(im.height, y1 + pad)
    return im.crop((x0, y0, x1, y1))


def fit_on_canvas(im: Image.Image, target_h_frac: float, lift: float = 0.0, x_shift: float = 0.0, scale: float = 1.0) -> Image.Image:
    im = crop_transparent(im)
    target_h = max(8, int(H * target_h_frac * scale))
    ratio = target_h / im.height
    nw, nh = max(1, int(im.width * ratio)), max(1, target_h)
    sprite = im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    x = int((W - nw) / 2 + x_shift * W)
    y = int(GROUND - nh - lift * 70)
    # 被抱起等抬高姿势：如果头顶会被裁掉，整体下移，宁可少抬一点。
    if y < 6:
        y = 6
    canvas.alpha_composite(sprite, (x, y))
    return canvas


def affine_about(im: Image.Image, pivot: tuple[float, float], scale_x=1.0, scale_y=1.0, angle=0.0) -> Image.Image:
    px, py = pivot
    sx, sy = scale_x, scale_y
    ang = math.radians(-angle)
    c, s = math.cos(ang), math.sin(ang)
    a = c * sx
    b = -s * sy
    d = s * sx
    e = c * sy
    det = a * e - b * d
    if abs(det) < 1e-8:
        return im
    ia, ib = e / det, -b / det
    id_, ie = -d / det, a / det
    cx = ia * (-px) + ib * (-py) + px
    cy = id_ * (-px) + ie * (-py) + py
    return im.transform(
        im.size,
        Image.Transform.AFFINE,
        (ia, ib, cx, id_, ie, cy),
        resample=Image.Resampling.BICUBIC,
    )


def mix(a: Image.Image, b: Image.Image, t: float) -> Image.Image:
    t = min(1.0, max(0.0, t))
    if t <= 0:
        return a.copy()
    if t >= 1:
        return b.copy()
    return Image.blend(a, b, t)


def ease(t: float) -> float:
    return 0.5 - 0.5 * math.cos(math.pi * min(1.0, max(0.0, t)))


def smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def add_shadow(canvas: Image.Image, lift: float, width_scale: float = 1.0) -> Image.Image:
    if lift > 0.95:
        return canvas
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(shadow)
    sw = 92 * width_scale * (1 - lift * 0.45)
    sh = 12 * (1 - lift * 0.5)
    sx, sy = W * 0.5, GROUND + 3
    d.ellipse((sx - sw, sy - sh, sx + sw, sy + sh), fill=(30, 20, 12, int(70 * (1 - lift * 0.5))))
    shadow = shadow.filter(ImageFilter.GaussianBlur(5))
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.alpha_composite(shadow)
    out.alpha_composite(canvas)
    return out


class PoseBank:
    def __init__(self) -> None:
        files = {
            "sit": SOURCE / "mido-reference.png",
            "blink": SOURCE / "mido-eyes-closed.jpg",
            "drowsy": SOURCE / "mido-drowsy-sit.jpg",
            "yawn": SOURCE / "mido-yawn.jpg",
            "look_l": SOURCE / "mido-look-left.jpg",
            "look_r": SOURCE / "mido-look-right.jpg",
            "head_tilt": SOURCE / "mido-head-tilt.jpg",
            "wag_l": SOURCE / "mido-wag-left.jpg",
            "wag_r": SOURCE / "mido-wag-right.jpg",
            "talk": SOURCE / "mido-talk.jpg",
            "think": SOURCE / "mido-think.jpg",
            "sad": SOURCE / "mido-sad.jpg",
            "sleep": SOURCE / "mido-sleep.jpg",
            "lie_start": SOURCE / "mido-lie-start.jpg",
            "lie_mid": SOURCE / "mido-lie-mid.jpg",
            "hop": SOURCE / "mido-hop.jpg",
            "held": SOURCE / "mido-held.jpg",
            "trot": SOURCE / "mido-trot.jpg",
            "trot2": SOURCE / "mido-trot-2.jpg",
            "spin_turn": SOURCE / "mido-spin-turn.jpg",
            "side_l": SOURCE / "mido-side-left.jpg",
            "side_r": SOURCE / "mido-side-right.jpg",
            "rear": SOURCE / "mido-rear.jpg",
            "dig": SOURCE / "mido-dig.jpg",
            "sniff": SOURCE / "mido-sniff.jpg",
            "stretch": SOURCE / "mido-stretch.jpg",
            "stretch_mid": SOURCE / "mido-stretch-mid.jpg",
            "basket": SOURCE / "mido-basket.jpg",
            "bell": SOURCE / "mido-bell.jpg",
            "bone": SOURCE / "mido-bone-mouth.jpg",
            "bowl": SOURCE / "mido-empty-bowl.jpg",
            "sad_bowl": SOURCE / "mido-sad-bowl.jpg",
        }
        self.raw: dict[str, Image.Image] = {}
        for name, path in files.items():
            if not path.exists():
                raise FileNotFoundError(f"缺少姿势底板：{path}")
            print(f"  keying {path.name} …", flush=True)
            self.raw[name] = load_pose(path)

    def plate(self, name: str, lift: float = 0.0, x_shift: float = 0.0, scale: float = 1.0) -> Image.Image:
        return fit_on_canvas(self.raw[name], POSE_HEIGHT[name], lift=lift, x_shift=x_shift, scale=scale)


def pose_mix(bank: PoseBank, weights: dict[str, float], lift=0.0, x_shift=0.0, scale=1.0) -> Image.Image:
    items = [(k, w) for k, w in weights.items() if w > 1e-4]
    if not items:
        return bank.plate("sit", lift, x_shift, scale)
    acc = bank.plate(items[0][0], lift, x_shift, scale)
    acc_w = items[0][1]
    for name, w in items[1:]:
        nxt = bank.plate(name, lift, x_shift, scale)
        acc_w_new = acc_w + w
        acc = mix(acc, nxt, w / acc_w_new)
        acc_w = acc_w_new
    return acc


def apply_motion(im: Image.Image, *, breath=0.0, squat=0.0, angle=0.0, lift=0.0) -> Image.Image:
    pivot = (W * 0.5, float(GROUND))
    sy = 1.0 + breath * 0.03 - squat * 0.08
    sx = 1.0 - breath * 0.012 + squat * 0.05
    if abs(sy - 1) < 1e-4 and abs(sx - 1) < 1e-4 and abs(angle) < 0.05:
        return im
    return affine_about(im, pivot, scale_x=sx, scale_y=sy, angle=angle)


def render(
    bank: PoseBank,
    weights: dict[str, float],
    *,
    breath=0.0,
    squat=0.0,
    angle=0.0,
    lift=0.0,
    x_shift=0.0,
    scale=1.0,
    shadow=True,
) -> Image.Image:
    im = pose_mix(bank, weights, lift=lift, x_shift=x_shift, scale=scale)
    im = apply_motion(im, breath=breath, squat=squat, angle=angle, lift=lift)
    if shadow:
        wide = 1.15 if max(weights.get("sleep", 0), weights.get("lie_mid", 0)) > 0.5 else 1.0
        im = add_shadow(im, lift, width_scale=wide)
    return im


def R(bank, name, **kw):
    return render(bank, {name: 1}, **kw)


def render_sit_motion(
    bank: PoseBank, *, tilt=0.0, ear_lag=0.0, tail_angle=0.0, tail_sway=(0.0, 0.0)
) -> Image.Image:
    sit = bank.plate("sit")
    move_head = bool(tilt or ear_lag)
    move_tail = bool(tail_angle or any(tail_sway))
    if not (move_head or move_tail):
        return add_shadow(sit, 0)

    # Inverse deformation of the seated pose on a mesh. The neck and tail root
    # taper to the untouched torso so the paws keep the same contact points.
    step = 10
    left, top, right = (0, 0, W) if move_head else (380, 180, 500)
    bottom = 310 if move_tail else 250
    x, y = np.meshgrid(np.arange(left, right + 1, step), np.arange(top, bottom + 1, step))
    head = 1 - smoothstep((y - 179) / 71)
    head *= 1 - smoothstep((x - 365) / 30) * smoothstep((y - 166) / 28)
    left_ear = np.exp(-((x - 210) / 30)**2 - ((y - 133) / 37)**2)
    right_ear = np.exp(-((x - 414) / 30)**2 - ((y - 123) / 37)**2)
    angle = np.radians(-tilt * head)
    cos, sin = np.cos(angle), np.sin(angle)
    dx, dy = x - 319, y - 196
    source_x = 319 + dx * cos - dy * sin - 0.19 * tilt * head
    source_y = 196 + dx * sin + dy * cos + 0.88 * ear_lag * (right_ear - left_ear) * head

    tail = smoothstep((x - 388) / 28) * smoothstep((y - 182) / 32) * (1 - smoothstep((y - 287) / 18))
    angle = np.radians(-tail_angle * tail)
    cos, sin = np.cos(angle), np.sin(angle)
    dx, dy = x - 400, y - 276
    source_x += dx * (cos - 1) - dy * sin + tail_sway[0] * tail
    source_y += dx * sin + dy * (cos - 1) + tail_sway[1] * tail

    mesh = []
    for row in range(y.shape[0] - 1):
        for col in range(x.shape[1] - 1):
            box = (col * step, row * step, (col + 1) * step, (row + 1) * step)
            corners = ((row, col), (row + 1, col), (row + 1, col + 1), (row, col + 1))
            quad = tuple(value[i, j] for i, j in corners for value in (source_x, source_y))
            mesh.append((box, quad))
    region = sit.transform((right - left, bottom - top), Image.Transform.MESH, mesh, resample=Image.Resampling.BICUBIC)
    sit.paste(region, (left, top))
    return add_shadow(sit, 0)


# ---------- 动画 ----------

def anim_wag(bank: PoseBank, t: float) -> Image.Image:
    # 摆动从尾根向外放大，尾尖稍晚转向，在切回待机前自然收住。
    amount = ease(min(t / 0.12, (0.96 - t) / 0.15))
    phase = math.tau * 2.25 * t
    return render_sit_motion(
        bank,
        tail_angle=18 * amount * math.sin(phase),
        tail_sway=(-1.5 * amount * math.sin(phase - 0.4), 5 * amount * math.sin(phase - 0.75)),
    )


TILT_KEYFRAMES = (
    (0.0, 0.0), (0.09, -1.2), (0.32, 13.0), (0.48, 10.8),
    (0.59, 11.1), (0.87, -0.8), (0.94, 0.0),
)


def sit_tilt_at(t: float) -> float:
    for (start, a), (end, b) in zip(TILT_KEYFRAMES, TILT_KEYFRAMES[1:]):
        if t < end:
            return a + (b - a) * ease((t - start) / (end - start))
    return 0.0


def anim_sit_tilt(bank: PoseBank, t: float) -> Image.Image:
    tilt = sit_tilt_at(t)
    ear_lag = sit_tilt_at(t - 0.035) - tilt
    return render_sit_motion(bank, tilt=tilt, ear_lag=ear_lag)


def anim_spin(bank: PoseBank, t: float) -> Image.Image:
    # 正面跑、追尾转身、左侧、背面、右侧，形成朝向变化的转圈。
    poses = ["trot", "spin_turn", "side_l", "rear", "side_r"]
    idx = int(t * len(poses)) % len(poses)
    # 在每段内轻微位移，保持运动感，但不靠缩放假装转身。
    local = (t * len(poses)) % 1.0
    return R(bank, poses[idx], lift=0.04, x_shift=math.sin((idx + local) / len(poses) * 2 * math.pi) * 0.03, breath=0.15)


ANIMATIONS: list[tuple[str, float, bool, object]] = [
    ("待机呼吸", 2.0, True, partial(LOCAL_MOTIONS["待机呼吸"], shadow=add_shadow)),
    ("转转头", 32 / FPS, True, partial(LOCAL_MOTIONS["转转头"], shadow=add_shadow)),
    ("被抱起", 25 / FPS, True, partial(dog_body_motion.held, shadow=add_shadow, affine=affine_about)),
    ("点击回应-摇尾欢跳", 25 / FPS, True, partial(dog_gait_motion.jump_frame, shadow=add_shadow)),
    ("小步跑", 25 / FPS, True, partial(dog_gait_motion.run_frame, shadow=add_shadow)),
    (STRETCH_MOTION, 30 / FPS, False, None),
    ("摇尾巴", 2 + 1 / FPS, True, anim_wag),
    ("坐下歪头", 2 + 1 / FPS, True, anim_sit_tilt),
    ("转圈追尾巴", 2.2, True, anim_spin),
    ("刨一刨", 2.0, True, None),
    ("余额-骨头满篮", 25 / FPS, False, None),
    ("余额-摇铃得意", 25 / FPS, False, None),
    ("余额-叼着骨头", 25 / FPS, False, None),
    ("余额-四处嗅寻", 25 / FPS, False, None),
    ("余额-空碗张望", 25 / FPS, False, None),
    ("余额-可怜巴巴", 25 / FPS, False, None),
    ("碎碎念-歪头咕哝", 25 / FPS, True, partial(LOCAL_MOTIONS["碎碎念-歪头咕哝"], shadow=add_shadow)),
    ("碎碎念-摇尾说话", 25 / FPS, True, partial(LOCAL_MOTIONS["碎碎念-摇尾说话"], shadow=add_shadow)),
    ("工作状态-歪头思索", 25 / FPS, True, partial(LOCAL_MOTIONS["工作状态-歪头思索"], shadow=add_shadow)),
    ("工作状态-刨地忙碌", 2.0, True, None),
    ("工作状态-摇尾汇报", 25 / FPS, True, partial(LOCAL_MOTIONS["工作状态-摇尾汇报"], shadow=add_shadow)),
    ("工作状态-坐等", 25 / FPS, True, partial(LOCAL_MOTIONS["工作状态-坐等"], shadow=add_shadow)),
    ("工作状态-欢跳成功", 25 / FPS, True, partial(dog_gait_motion.jump_frame, shadow=add_shadow, success=True)),
    ("工作状态-垂耳失落", 25 / FPS, True, partial(LOCAL_MOTIONS["工作状态-垂耳失落"], shadow=add_shadow)),
    ("睡觉-入睡", 34 / FPS, False, None),
    ("睡觉-循环", 25 / FPS, False, partial(dog_body_motion.sleeping, shadow=add_shadow)),
    ("睡觉-醒来", 34 / FPS, False, None),
]


def sequence(bank: PoseBank, fn, seconds: float, loop: bool, *, fps: int = FPS, hold_first: bool = True) -> list[Image.Image]:
    n = max(2, int(round(seconds * fps)))
    frames = []
    for i in range(n):
        t = i / n if loop else (i / (n - 1) if n > 1 else 0.0)
        frames.append(fn(bank, t))
    if loop and hold_first:
        frames.append(frames[0].copy())
    return frames


def encode_webm(frames: list[Image.Image], dest: Path, fps: int = FPS, *, crf: int | None = None,
                cpu_used: int = 3, sleep_seam: bool = False) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="dsh-dog-"))
    try:
        for i, im in enumerate(frames):
            im.save(tmp / f"{i:04d}.png")
        quality = ["-b:v", "900k"] if crf is None else ["-b:v", "0", "-crf", str(crf)]
        seam = []
        if sleep_seam:
            # Encode the two identical sleep poses as keyframes, matching the adjacent clips.
            seam = ["-lag-in-frames", "0", "-g", "240", "-aq-mode", "0",
                    "-force_key_frames", f"0,{(len(frames) - 1) / fps:.7f}"]
        cmd = [
            "ffmpeg", "-y", "-framerate", str(fps), "-i", str(tmp / "%04d.png"),
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
            *quality, "-deadline", "good", "-cpu-used", str(cpu_used), *seam, "-an", str(dest),
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            sys.stderr.write(proc.stderr[-4000:])
            raise SystemExit(f"ffmpeg failed for {dest.name} (exit {proc.returncode})")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def encode_gif(frames: list[Image.Image], dest: Path, fps: int = FPS) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="dsh-dog-gif-"))
    try:
        for i, im in enumerate(frames):
            im.save(tmp / f"{i:04d}.png")
        filt = (
            "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];"
            "[s0]palettegen=reserve_transparent=1:stats_mode=single[p];"
            "[s1][p]paletteuse=new=1:alpha_threshold=128"
        )
        cmd = ["ffmpeg", "-y", "-framerate", str(fps), "-i", str(tmp / "%04d.png"), "-vf", filt, "-loop", "0", str(dest)]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            sys.stderr.write(proc.stderr[-2000:])
            print("warn: preview gif failed", dest.name, file=sys.stderr)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def make_character_still(bank: PoseBank) -> Image.Image:
    src = crop_transparent(bank.raw["sit"], pad=24)
    side = max(src.width, src.height) + 40
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(src, ((side - src.width) // 2, (side - src.height) // 2))
    return canvas.resize((1024, 1024), Image.Resampling.LANCZOS)


def make_logo(char: Image.Image) -> Image.Image:
    a = np.array(char.split()[-1])
    ys, xs = np.where(a > 8)
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    head = char.crop((x0, y0, x1, y0 + int((y1 - y0) * 0.72)))
    head = crop_transparent(head, pad=8)
    inner = 196
    ratio = min(inner / head.width, inner / head.height)
    head = head.resize((int(head.width * ratio), int(head.height * ratio)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    d.ellipse((8, 8, 248, 248), fill=(255, 247, 230, 255), outline=(58, 36, 22, 255), width=6)
    d.ellipse((18, 18, 238, 238), outline=(196, 140, 86, 255), width=5)
    canvas.alpha_composite(head, ((256 - head.width) // 2, 22 + (210 - head.height) // 2))
    return canvas


def _opaque_top(im: Image.Image) -> int:
    a = np.array(im.split()[-1])
    ys, xs = np.where(a > 8)
    return int(ys.min()) if len(ys) else H


def main() -> None:
    print("loading pose plates from", SOURCE, flush=True)
    bank = PoseBank()
    ANIM_DIR.mkdir(parents=True, exist_ok=True)

    still = make_character_still(bank)
    still_path = OUT_DIR / "dog-character.png"
    still.save(still_path)
    print("wrote", still_path, flush=True)

    logo = make_logo(still)
    logo_path = ROOT / "assets" / "logo.png"
    logo.save(logo_path)
    print("wrote", logo_path, flush=True)

    # 先把睡觉三段算出来，检查对齐和入睡中段不透明。
    preview_frames = None
    sleep_sets: dict[str, list[Image.Image]] = {}
    from dog_dig_motion import render_digging

    dig_frames = render_digging(MOTION_MASTERS / "dig.webm")
    for name, seconds, loop, fn in ANIMATIONS:
        rate = SMOOTH_LOOP_RATES.get(name, FPS)
        if name in DIG_MOTIONS:
            frames = dig_frames
        elif name == STRETCH_MOTION:
            frames = dog_stretch_motion.render_stretch(bank, MOTION_MASTERS, shadow=add_shadow)
        elif name in SLEEP_TRANSITIONS:
            frames = dog_sleep_motion.render_transition(
                bank, MOTION_MASTERS, waking=SLEEP_TRANSITIONS[name], shadow=add_shadow
            )
        elif name in BALANCE_MOTIONS:
            pose = BALANCE_MOTIONS[name]
            with Image.open(MOTION_MASTERS / f"{pose}-master.png") as master:
                plate = master.convert("RGBA")
            count = round(seconds * rate)
            frames = [dog_balance_motion.render_balance_motion(plate, pose, i / (count - 1)) for i in range(count)]
        else:
            frames = sequence(bank, fn, seconds, loop, fps=rate, hold_first=name not in SMOOTH_LOOP_RATES)
        if name.startswith("睡觉-"):
            sleep_sets[name] = frames
        dest = ANIM_DIR / f"{name}.webm"
        crf = None
        if name in GAIT_MOTIONS:
            crf = 22
        elif name in DIG_MOTIONS or name == STRETCH_MOTION:
            crf = 26
        elif name in BALANCE_MOTIONS:
            crf = 28
        elif name in LOCAL_MOTIONS or name in BODY_MOTIONS or name in SLEEP_TRANSITIONS or name == "坐下歪头":
            crf = 27
        encode_webm(frames, dest, rate, crf=crf, cpu_used=4 if name in GAIT_MOTIONS or name == STRETCH_MOTION else 3,
                    sleep_seam=name == "睡觉-循环" or name in SLEEP_TRANSITIONS)
        top = _opaque_top(frames[len(frames)//2])
        print(f"  {name}.webm  ({len(frames)} frames, {dest.stat().st_size} bytes, mid-top={top})", flush=True)
        if name == "待机呼吸":
            preview_frames = frames
        if name == "被抱起":
            for i, fr in enumerate(frames):
                if _opaque_top(fr) <= 1:
                    print(f"  WARN 被抱起 frame {i} may clip head", flush=True)

    if "睡觉-入睡" in sleep_sets:
        start, loop, end = sleep_sets["睡觉-入睡"], sleep_sets["睡觉-循环"], sleep_sets["睡觉-醒来"]
        a = np.array(start[-1])
        b = np.array(loop[0])
        c = np.array(loop[-1])
        d = np.array(end[0])
        mid = np.array(start[len(start)//2])
        print("sleep start-end vs loop[0] identical:", (a == b).all(), "diff", int((a != b).any(axis=2).sum()) if a.shape == b.shape else "shape")
        print("sleep loop first vs last identical:", (b == c).all(), "diff", int((b != c).any(axis=2).sum()))
        print("sleep loop[0] vs end[0] identical:", (b == d).all(), "diff", int((b != d).any(axis=2).sum()) if b.shape == d.shape else "shape")
        print("sleep start mid alpha min/mean of opaque:", int(mid[..., 3][mid[..., 3] > 8].min()) if (mid[..., 3] > 8).any() else "none",
              "mean-alpha-all", round(float(mid[..., 3].mean()), 1))
        # 中段不应是半透明整狗：不透明像素的 alpha 应接近 255
        op = mid[..., 3][mid[..., 3] > 8]
        if len(op):
            print("sleep start mid opaque alpha p50/p10:", int(np.median(op)), int(np.percentile(op, 10)))

    if preview_frames:
        encode_gif(preview_frames, OUT_DIR / "preview.gif", SMOOTH_LOOP_RATES.get("待机呼吸", FPS))
        print("wrote preview.gif", flush=True)
    print("done", len(ANIMATIONS), "animations →", ANIM_DIR, flush=True)


if __name__ == "__main__":
    main()
