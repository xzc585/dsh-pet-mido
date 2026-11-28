"""Interpolate the authored digging frames without replacing the dust or the dog."""

import subprocess

import cv2
import numpy as np
from PIL import Image

W, H = 640, 360
GRID = np.dstack(np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32)))


def decode(path):
    data = subprocess.check_output([
        "ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", path,
        "-f", "rawvideo", "-pix_fmt", "rgba", "-threads", "1", "-",
    ])
    return np.frombuffer(data, dtype=np.uint8).reshape((-1, H, W, 4))


def sensor(frame):
    alpha = frame[..., 3:] / 255.0
    rgb = (frame[..., :3] * alpha + 70 * (1 - alpha)).astype(np.uint8)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    return cv2.resize(gray, (W // 2, H // 2), interpolation=cv2.INTER_AREA)


def flow_between(dis, a, b):
    flow = dis.calc(sensor(a), sensor(b), None)
    flow = cv2.resize(flow, (W, H), interpolation=cv2.INTER_CUBIC) * 2
    return cv2.GaussianBlur(flow, (7, 7), 1.4)


def warp_halfway(frame, flow):
    pos = GRID.copy()
    for _ in range(5):
        sampled = cv2.remap(flow, pos, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        pos = 0.5 * pos + 0.5 * (GRID - 0.5 * sampled)
    pixels = frame.astype(np.float32) / 255.0
    pixels[..., :3] *= pixels[..., 3:]
    result = cv2.remap(pixels, pos, None, cv2.INTER_LINEAR)
    np.divide(result[..., :3], result[..., 3:], out=result[..., :3], where=result[..., 3:] > 1e-6)
    return np.uint8(np.clip(result * 255, 0, 255))


def in_between(dis, a, b):
    start = warp_halfway(a, flow_between(dis, a, b))
    end = warp_halfway(b, flow_between(dis, b, a))
    # Keep a single silhouette. Blend only aligned pixels inside the solid fur.
    color_gap = np.max(np.abs(start[..., :3].astype(np.int16) - end[..., :3]), axis=2)
    stable = (start[..., 3] > 238) & (end[..., 3] > 238) & (color_gap < 48)
    start[stable, :3] = 0.5 * start[stable, :3] + 0.5 * end[stable, :3]
    return start


def render_digging(master):
    original = decode(master)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    frames = []
    for a, b in zip(original, np.roll(original, -1, axis=0)):
        frames.extend((Image.fromarray(a), Image.fromarray(in_between(dis, a, b))))
    return frames
