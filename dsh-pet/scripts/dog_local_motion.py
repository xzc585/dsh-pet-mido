"""Articulated motion on the original 640×360 Mido pose plates."""

import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

STEP = 10
X, Y = np.meshgrid(np.arange(0, 641, STEP), np.arange(0, 361, STEP))


def ease(value):
    return 0.5 - 0.5 * math.cos(math.pi * min(1, max(0, value)))


def pulse(t, start, peak, release, end):
    return ease((t - start) / (peak - start)) * ease((end - t) / (end - release))


def smoothstep(value):
    u = np.clip(value, 0, 1)
    return u * u * (3 - 2 * u)


class PoseMotion:
    """Accumulate inverse displacement fields, then resample the pose once."""

    def __init__(self, pose):
        self.pose = pose
        self.dx = np.zeros(X.shape)
        self.dy = np.zeros(Y.shape)

    def move(self, center, radius, *, x=0, y=0, rotate=0, scale_x=0, scale_y=0,
             weight=None):
        cx, cy = center
        rx, ry = radius
        ax, ay = X - cx, Y - cy
        blend = smoothstep(1.5 * (1 - (ax/rx)**2 - (ay/ry)**2))
        if weight is not None:
            blend *= weight
        angle = math.radians(-rotate)
        sine, cosine = math.sin(angle), math.cos(angle)
        self.dx += blend * (ax*(cosine-1-scale_x) - ay*sine - x)
        self.dy += blend * (ax*sine + ay*(cosine-1-scale_y) - y)

    def draw(self):
        active = np.abs(self.dx) + np.abs(self.dy) > 0.001
        rows, cols = np.where(active)
        if not len(rows):
            return self.pose
        min_y, max_y = max(0, rows.min()-1), min(len(Y)-1, rows.max()+1)
        min_x, max_x = max(0, cols.min()-1), min(X.shape[1]-1, cols.max()+1)
        u, v = X + self.dx, Y + self.dy
        mesh = []
        for row in range(min_y, max_y):
            for col in range(min_x, max_x):
                px, py = (col-min_x)*STEP, (row-min_y)*STEP
                corners = ((row, col), (row+1, col), (row+1, col+1), (row, col+1))
                quad = tuple(axis[i, j] for i, j in corners for axis in (u, v))
                mesh.append(((px, py, px+STEP, py+STEP), quad))
        size = ((max_x-min_x)*STEP, (max_y-min_y)*STEP)
        changed = self.pose.transform(size, Image.Transform.MESH, mesh, resample=Image.Resampling.BICUBIC)
        sprite = self.pose.copy()
        sprite.paste(changed, (min_x*STEP, min_y*STEP))
        return sprite


LOWER_HEAD = (1 - smoothstep((Y - 185) / 62)) * (
    1 - smoothstep((X - 365) / 30) * smoothstep((Y - 166) / 28)
)
PAWS = smoothstep((Y - 263) / 14)


def seated_head(motion, *, tilt=0, yaw=0, nod=0, ears=0, yaw_shift=(16, 11)):
    motion.move((319,168),(175,166), x=yaw_shift[0]*yaw, y=nod, rotate=tilt,
                scale_x=-0.025*abs(yaw), weight=LOWER_HEAD)
    motion.move((317,126),(129,112),x=yaw_shift[1]*yaw)
    motion.move((218,110),(54,72),y=ears,rotate=-1.5*yaw)
    motion.move((413,99),(49,71),y=-ears,rotate=-1.5*yaw)


def chest(motion, value):
    motion.move((317,236),(89,61),y=-1.25*value,scale_x=0.035*value,
                scale_y=0.043*value,weight=1-PAWS)


def tail(motion, phase, amount):
    motion.move((406,273),(106,99),x=-2*amount*math.sin(phase-0.3),
                y=-4*amount*math.sin(phase-0.7),rotate=17*amount*math.sin(phase),
                weight=smoothstep((X-390)/26)*smoothstep((Y-188)/28)*(1-smoothstep((Y-287)/22)))


# Keep the original eyelids and leave the muzzle, ears and silhouette alone.
def blinking_face(bank, amount):
    sitting = bank.plate("sit")
    if not amount:
        return sitting
    if amount < 0.87:
        closing = PoseMotion(sitting)
        closing.move((277,111),(35,30),scale_y=-0.77*amount,y=4*amount)
        closing.move((359,104),(37,30),scale_y=-0.77*amount,y=4*amount)
        return closing.draw()
    lids = bank.plate("blink")
    mask = Image.new("L", sitting.size)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((251,84,305,133),fill=255)
    draw.ellipse((331,73,389,134),fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    return Image.composite(lids,sitting,mask)


def idle(bank, t, *, shadow):
    lids = pulse(t,0.48,0.524,0.538,0.59)
    motion = PoseMotion(blinking_face(bank,lids))
    chest(motion,math.sin(math.tau*t))
    return shadow(motion.draw(),0)


def whisper_tilt(bank, t, *, shadow):
    lean = pulse(t,0.025,0.26,0.72,0.96)
    mumble = pulse(t,0.23,0.29,0.32,0.40)+0.7*pulse(t,0.50,0.56,0.60,0.69)
    motion = PoseMotion(bank.plate("sit"))
    motion.move((318,165),(42,29),scale_y=-0.28*mumble,y=2.4*mumble)
    seated_head(motion,tilt=-10*lean,yaw=-0.21*lean,nod=2.2*lean,ears=0.8*mumble)
    return shadow(motion.draw(),0)


def whisper_talk(bank, t, *, shadow):
    phrase = pulse(t,0.04,0.13,0.17,0.25)+pulse(t,0.27,0.34,0.39,0.49)+0.8*pulse(t,0.55,0.63,0.69,0.81)
    wag = pulse(t,0.04,0.19,0.70,0.96)
    motion = PoseMotion(bank.plate("talk"))
    motion.move((328,165),(50,33),scale_y=-0.33+0.54*phrase,
                y=1.5*phrase,scale_x=0.08*phrase)
    seated_head(motion, tilt=1.3*phrase,nod=4*phrase)
    tail(motion,math.tau*2.5*t,wag*0.68)
    return shadow(motion.draw(),0)


def think(bank, t, *, shadow):
    inquire = pulse(t,0.035,0.36,0.59,0.96)
    motion = PoseMotion(bank.plate("think"))
    # Keep the raised paw's contact at the chin.
    motion.move((305,109),(127,92),y=-4*inquire,x=-5*inquire,rotate=-4.8*inquire)
    motion.move((414,100),(45,62),y=3.3*math.sin(math.pi*inquire))
    chest(motion,0.38*math.sin(math.tau*t))
    return shadow(motion.draw(),0)


def report(bank, t, *, shadow):
    wag = pulse(t,0.01,0.15,0.70,0.98)
    nod = pulse(t,0.13,0.25,0.28,0.46)+0.65*pulse(t,0.51,0.62,0.67,0.83)
    motion = PoseMotion(bank.plate("sit"))
    seated_head(motion,tilt=3.7*nod,nod=-6.4*nod)
    chest(motion,0.5*nod)
    tail(motion,math.tau*2.9*t,wag)
    return shadow(motion.draw(),0)


def wait(bank, t, *, shadow):
    listen = pulse(t,0.02,0.30,0.66,0.97)
    motion = PoseMotion(blinking_face(bank,0.92*pulse(t,0.69,0.74,0.76,0.83)))
    seated_head(motion,tilt=-4.3*listen,yaw=0.26*listen,nod=-4.7*listen,yaw_shift=(13, 8))
    chest(motion,0.36*math.sin(math.tau*t))
    motion.move((414,104),(48,60),rotate=-4*pulse(t,0.15,0.23,0.27,0.39))
    return shadow(motion.draw(),0)


def sad(bank, t, *, shadow):
    deject = pulse(t,0.035,0.29,0.65,0.96)
    motion = PoseMotion(bank.plate("sad"))
    seated_head(motion,tilt=-3.3*deject,nod=11*deject,yaw=-0.1*deject)
    motion.move((219,123),(54,65),y=5.5*deject,rotate=-7*deject)
    motion.move((412,115),(50,67),y=5.5*deject,rotate=7*deject)
    chest(motion,-0.6*deject)
    return shadow(motion.draw(),0)
