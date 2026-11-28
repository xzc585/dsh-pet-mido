"""Localized recoil when held, and breathing while asleep."""

import math

import numpy as np
from PIL import Image

W, H = 640, 360


def smoothstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def deform(plate, field):
    """Sample one opaque silhouette through a smooth inverse mesh."""
    step = 8
    px, py = np.meshgrid(np.arange(0, W + 1, step), np.arange(0, H + 1, step))
    dx, dy = field(px, py)
    xs, ys = px + dx, py + dy
    mesh = []
    for row, col in np.ndindex(py.shape[0] - 1, px.shape[1] - 1):
        corners = ((row, col), (row + 1, col), (row + 1, col + 1), (row, col + 1))
        quad = tuple(float(value[i, j]) for i, j in corners for value in (xs, ys))
        mesh.append(((col * step, row * step, (col + 1) * step, (row + 1) * step), quad))
    return plate.transform((W, H), Image.Transform.MESH, mesh, resample=Image.Resampling.BICUBIC)


def sleeping(bank, t, *, shadow):
    plate = bank.plate("sleep")
    amount = (1 - math.cos(math.tau * t)) / 2
    if amount == 0:
        return shadow(plate, 0, width_scale=1.15)

    def field(x, y):
        # The ribs move on an inhale. Taper above the contact paws and keep
        # the muzzle and ear still instead of scaling the entire sleeper.
        mask = smoothstep((x - 316) / 48) * (1 - smoothstep((y - 252) / 44))
        ribs = mask * np.exp(-((x - 400) / 83)**2 - ((y - 190) / 65)**2)
        return -1.9 * amount * ribs, 3.8 * amount * ribs

    return shadow(deform(plate, field), 0, width_scale=1.15)


def held(bank, t, *, shadow, affine):
    plate = bank.plate("held", lift=0.18)
    phase = math.tau * t
    if t == 0:
        return shadow(plate, 0.18)

    def field(x, y):
        # Limbs swing with a slight phase difference about their joints.
        # The face, torso and tail keep their original shapes.
        lower = smoothstep((y - 215) / 35) * (1 - smoothstep((x - 370) / 14))
        near = lower * np.exp(-((x - 257) / 29)**2 - ((y - 262) / 39)**2)
        far = lower * np.exp(-((x - 339) / 39)**2 - ((y - 273) / 37)**2)
        leg = math.sin(phase * 2)
        lag = math.sin(phase * 2 - 0.58) + math.sin(0.58) * math.cos(phase)
        return 4.2 * leg * near - 3.4 * lag * far, -2.4 * leg * near + 3.6 * lag * far

    body = deform(plate, field)
    angle = math.sin(phase * 2) * 1.6 + math.sin(phase) * 0.7
    y = math.sin(phase * 2) * 6
    body = affine(body, (320.0, 186.0), angle=angle)
    body = body.transform((W, H), Image.Transform.AFFINE, (1, 0, 0, 0, 1, -y), Image.Resampling.BICUBIC)
    return shadow(body, 0.18 + y / 360)
