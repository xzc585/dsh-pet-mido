"""Mido's grounded trot and two airborne gestures."""

import math

import numpy as np
from PIL import Image

W, H = 640, 360
DURATION = 25 / 12
LEAD = 0.4
TRAVEL = DURATION - 2 * LEAD
END = DURATION - LEAD
T = 8
X = np.arange(0, W + 1, T, dtype=np.float32)
Y = np.arange(0, H + 1, T, dtype=np.float32)
GX, GY = np.meshgrid(X, Y)
GRID = np.stack((GX, GY), axis=-1)


def smooth(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def inverse_affine(pixels, pivot, shift, angle, scale):
    a = math.radians(angle)
    c, s = math.cos(a), math.sin(a)
    inverse = np.float32([[c / scale[0], s / scale[0]], [-s / scale[1], c / scale[1]]])
    return (pixels - pivot - shift) @ inverse.T + pivot


def mesh(plate, deformation, *, pivot=(323, 232), shift=(0, 0), angle=0, scale=(1, 1)):
    """Warp a single image with one bicubic sample per output pixel."""
    base = inverse_affine(GRID, pivot, shift, angle, scale)
    mapping = base
    for _ in range(7):
        mapping = 0.55 * base + 0.45 * mapping - 0.55 * deformation(mapping)
    horizontal = (mapping[:-1, 1:] - mapping[:-1, :-1]) / T
    vertical = (mapping[1:, :-1] - mapping[:-1, :-1]) / T
    jacobian = horizontal[..., 0] * vertical[..., 1] - horizontal[..., 1] * vertical[..., 0]
    if jacobian.min() <= 0:
        raise ValueError(f'folded pose mesh {jacobian.min():.3f}')
    pieces = [
        (
            (int(X[c]), int(Y[r]), int(X[c + 1]), int(Y[r + 1])),
            tuple(np.concatenate((mapping[r, c], mapping[r + 1, c], mapping[r + 1, c + 1], mapping[r, c + 1]))),
        )
        for r in range(len(Y) - 1)
        for c in range(len(X) - 1)
    ]
    return plate.transform((W, H), Image.Transform.MESH, pieces, Image.Resampling.BICUBIC)


LIMBS = (
    ((272, 228), (242, 282), 20, 0.50, 10),
    ((307, 226), (286, 305), 23, 0.00, 0),
    ((369, 253), (346, 300), 16, 0.00, 1),
    ((408, 229), (436, 285), 20, 0.50, 9),
)


def support(pixels, joint, paw, width):
    x, y = pixels[..., 0], pixels[..., 1]
    portion = np.clip((y - joint[1]) / (paw[1] - joint[1]), 0, 1)
    center = joint[0] + portion * (paw[0] - joint[0])
    return smooth(portion) * np.exp(-0.58 * ((x - center) / width) ** 4)


def run_frame(bank, t, *, shadow):
    """Two diagonal cycles during actual travel, with planted prep and settle."""
    sec = t * DURATION
    phase = np.clip((sec - LEAD) / TRAVEL, 0, 1)
    envelope = smooth((sec - LEAD) / 0.15) * smooth((END - sec) / 0.18)
    cycle = float(phase * 2)
    prep = math.sin(math.pi * np.clip(sec / LEAD, 0, 1)) ** 2
    settle = math.sin(math.pi * np.clip((sec - END) / LEAD, 0, 1)) ** 2
    bob = envelope * (1.9 * math.cos(4 * math.pi * cycle + 0.38) - 1.1) + 2.2 * prep + 2.8 * settle
    surge = 1.6 * envelope * math.sin(4 * math.pi * cycle)
    angle = 0.9 * envelope * math.sin(4 * math.pi * cycle - 0.55) - 1.25 * prep + 0.8 * settle
    pivot, shift = (323, 232), (surge, bob)
    offsets = []
    for _, paw, _, stagger, drop in LIMBS:
        part = (cycle + stagger) % 1
        # Constant stance speed matches the runtime's linear travel. The
        # Hermite swing reverses smoothly and meets the next stance tangent.
        if part < 0.5:
            travel_x = -1 + 4 * part
        else:
            step = 2 * part - 1
            travel_x = 1 + 2 * step - 12 * step**2 + 8 * step**3
        reach = 14 * envelope * travel_x
        clearance = envelope * 12 * math.sin((part - 0.5) * math.tau) ** 2 if part >= 0.5 else 0
        target = np.float32([paw[0] + reach, paw[1] + drop - clearance])
        offsets.append(inverse_affine(target, pivot, shift, angle, (1, 1)) - paw)
    offsets = np.float32(offsets)
    tail = np.float32([
        3.1 * envelope * math.sin(2 * math.pi * cycle - 0.75),
        4.2 * envelope * math.sin(4 * math.pi * cycle - 1.3),
    ])

    def deformation(pixels):
        weights = np.stack([support(pixels, joint, paw, width) for joint, paw, width, _, _ in LIMBS], axis=-1)
        weights /= np.maximum(1, weights.sum(axis=-1, keepdims=True))
        x, y = pixels[..., 0], pixels[..., 1]
        tail_mask = smooth((x - 392) / 45) * smooth((217 - y) / 78) * smooth((y - 101) / 30)
        return weights @ offsets + tail_mask[..., None] * tail

    plate = mesh(bank.plate("trot"), deformation, pivot=pivot, shift=shift, angle=angle)
    return shadow(plate, 0.04 + max(0, -bob) / 70)


def jump_frame(bank, t, *, shadow, success=False):
    second_hop = not success and t >= 0.5
    phase = t if success else (t * 2) % 1
    takeoff = 0.21 if success else 0.19
    touchdown = 0.62 if success else 0.72
    crouch = rise = tuck = 0.0
    if phase < takeoff:
        crouch = 0.067 * smooth(phase / takeoff)
    elif phase <= touchdown:
        flight = (phase - takeoff) / (touchdown - takeoff)
        rise = (24 if success else 18.5 if second_hop else 21.5) * 4 * flight * (1 - flight)
        crouch = 0.067 * math.exp(-flight * 14)
        tuck = math.sin(math.pi * flight) ** 1.3
    else:
        rebound = (phase - touchdown) / max(0.08, (1 - touchdown) * (0.50 if success else 0.84))
        crouch = 0.044 * math.sin(math.pi * np.clip(rebound, 0, 1)) ** 2

    paw_joint_l, paw_l = (269, 233), (275, 300)
    paw_joint_r, paw_r = (350, 233), (357, 301)
    paw_left = np.float32([-6.2 * tuck, -17.5 * tuck])
    paw_right = np.float32([5.5 * tuck, -12.8 * tuck])
    cheer_phase = ((phase - 0.68) * 7 if success else phase * 1.2) * math.tau
    cheer = smooth((phase - 0.67) / 0.09) * smooth((0.97 - phase) / 0.09) if success else tuck
    tail = np.float32([7.8 * cheer * math.sin(cheer_phase), 5.7 * cheer * math.cos(cheer_phase)])

    def deformation(pixels):
        x, y = pixels[..., 0], pixels[..., 1]
        tail_mask = smooth((x - 385) / 32) * smooth((y - 197) / 28) * smooth((317 - y) / 48)
        left_toe_turn = 0.16 * tuck * (pixels - [269, 274])[..., ::-1] * [1, -1]
        right_toe_turn = 0.13 * tuck * (pixels - [352, 274])[..., ::-1] * [-1, 1]
        shoulder = smooth((y - 158) / 74) * smooth((284 - y) / 70) * smooth((x - 219) / 60) * smooth((421 - x) / 60)
        chest = np.float32([(2.2 if second_hop else -2.2) * tuck, -3.5 * tuck])
        neck_fold = (1 - smooth((y - 168) / 115)) * ((16.7 if success else 13.4) * tuck)
        return (support(pixels, paw_joint_l, paw_l, 24)[..., None] * (paw_left + left_toe_turn) +
                support(pixels, paw_joint_r, paw_r, 26)[..., None] * (paw_right + right_toe_turn) +
                shoulder[..., None] * chest +
                np.stack((np.zeros_like(y), neck_fold), axis=-1) +
                tail_mask[..., None] * tail)

    shift = ((-2.0 if second_hop else 1.8) * tuck, -rise)
    sample = mesh(bank.plate("sit"), deformation, pivot=(320, 306), shift=shift,
                            angle=(2.7 if success else -2.5 if second_hop else 2.4) * tuck,
                            scale=(1 + 0.42 * crouch, 1 - crouch))
    return shadow(sample, rise / 70)
