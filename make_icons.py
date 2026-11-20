"""Generates icons/icon{16,48,128}.png (dark rounded square with an off-white target ring and orange dot). stdlib only."""
import math, os, struct, zlib

def png(size):
    px = bytearray()
    c = (size - 1) / 2
    for y in range(size):
        px.append(0)
        for x in range(size):
            # rounded-square mask
            r = size * 0.22
            dx = max(abs(x - c) - (size / 2 - r), 0); dy = max(abs(y - c) - (size / 2 - r), 0)
            a = 1.0 if math.hypot(dx, dy) <= r else 0.0
            d = math.hypot(x - c, y - c)
            ring = size * 0.30 <= d <= size * 0.38
            dot = d <= size * 0.11
            cross = (abs(x - c) <= size * 0.04 and d >= size * 0.30) or (abs(y - c) <= size * 0.04 and d >= size * 0.30)
            white = ring or dot or (cross and d <= size * 0.46)
            rgb = ((255, 74, 15) if dot else (242, 240, 234)) if white else (27, 27, 27)
            px += bytes((*rgb, int(255 * a)))
    def chunk(t, d):
        b = t + d
        return struct.pack('>I', len(d)) + b + struct.pack('>I', zlib.crc32(b) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(px), 9)) + chunk(b'IEND', b''))

os.makedirs('icons', exist_ok=True)
for s in (16, 48, 128):
    with open(f'icons/icon{s}.png', 'wb') as f:
        f.write(png(s))
