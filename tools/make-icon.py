#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Windows 应用图标 build/icon.ico（内含 256x256 PNG，Vista+ 支持）。

用法：python3 tools/make-icon.py
无需任何第三方依赖（png 用 zlib 手写，ico 直接内嵌 PNG 数据）。
"""

import os
import struct
import zlib

SIZE = 256
SS = 3  # 超采样倍数，用于抗锯齿

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "icon.ico")


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_rect_contains(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def envelope_contains(x, y):
    # 信封主体（白色圆角矩形）
    if rounded_rect_contains(x, y, 52, 84, 204, 176, 10):
        return "body"
    return None


def flap_distance(x, y):
    """到信封折线（V 形封口）的距离，用于绘制折线"""
    # 两条线段：(52,88)-(128,142) 与 (128,142)-(204,88)
    best = 1e9
    for (x0, y0, x1, y1) in ((56, 92, 128, 142), (128, 142, 200, 92)):
        vx, vy = x1 - x0, y1 - y0
        wx, wy = x - x0, y - y0
        seg = vx * vx + vy * vy
        t = 0 if seg == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / seg))
        px, py = x0 + t * vx, y0 + t * vy
        d = ((x - px) ** 2 + (y - py) ** 2) ** 0.5
        best = min(best, d)
    return best


def in_flap_triangle(x, y):
    """是否落在信封封口三角区域内：(56,92) - (128,146) - (200,92)"""
    ax, ay = 56.0, 92.0
    bx, by = 128.0, 146.0
    cx, cy = 200.0, 92.0
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def sample(x, y):
    """返回 (r, g, b, a) —— 单点采样"""
    # 背景渐变圆角方块
    t = (x + y) / (SIZE * 2.0)
    bg = (int(lerp(76, 123, t)), int(lerp(141, 92, t)), int(lerp(255, 255, t)))
    if not rounded_rect_contains(x, y, 6, 6, SIZE - 6, SIZE - 6, 52):
        return (0, 0, 0, 0)

    body = rounded_rect_contains(x, y, 52, 84, 204, 176, 10)

    # 信封底部投影（仅在主体之外露出）
    if not body and rounded_rect_contains(x, y, 52, 90, 204, 182, 10):
        return (168, 188, 232, 255)

    if body:
        d = flap_distance(x, y)
        if d <= 3.4:
            return (86, 140, 248, 255)
        # 封口三角区域：淡蓝色
        if in_flap_triangle(x, y):
            return (214, 226, 252, 255)
        # 信封下半部分轻微渐变
        if y > 150:
            return (238, 243, 253, 255)
        return (255, 255, 255, 255)

    return bg + (255,)


def build_png(size):
    """生成 size x size 的 PNG（RGBA）"""
    rows = []
    for py in range(size):
        row = bytearray([0])  # filter type 0
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    sr, sg, sb, sa = sample(x, y)
                    r += sr * sa / 255.0
                    g += sg * sa / 255.0
                    b += sb * sa / 255.0
                    a += sa
            n = SS * SS
            if a == 0:
                row += bytes([0, 0, 0, 0])
            else:
                row += bytes(
                    [
                        min(255, int(r / (a / 255.0))),
                        min(255, int(g / (a / 255.0))),
                        min(255, int(b / (a / 255.0))),
                        min(255, int(a / n)),
                    ]
                )
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    png = build_png(SIZE)
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack(
        "<BBBBHHII",
        0,  # width 0 = 256
        0,  # height 0 = 256
        0,  # palette
        0,  # reserved
        1,  # planes
        32,  # bpp
        len(png),
        len(header) + 16,
    )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as fh:
        fh.write(header + entry + png)
    print(f"已生成 {os.path.abspath(OUT)}（{os.path.getsize(OUT)} 字节）")


if __name__ == "__main__":
    main()
