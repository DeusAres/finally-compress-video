#!/usr/bin/env python3
"""Genera icons/*.png (pixel art) dal logo di app/ui/sprite.js: icon-192/512, apple-touch-icon (180), favicon-32.
PNG scritti a mano con zlib (nessuna dipendenza). Uso: python3 tools/make-icons.py"""
import os, re, struct, zlib
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
COL = {'k': (0x1a, 0x1c, 0x2c), 'w': (0xf4, 0xf4, 0xf4), 'b': (0x3b, 0x5d, 0xc9), 'y': (0xff, 0xcd, 0x75)}
BG = (0xf3, 0xec, 0xdc)   # --px-paper
src = open(os.path.join(ROOT, 'app/ui/sprite.js'), encoding='utf-8').read()
block = re.search(r'logo:\s*\[(.*?)\]', src, re.S).group(1)
ROWS = re.findall(r"'([^']+)'", block)
W, H = len(ROWS[0]), len(ROWS)

def render(size, scale):
    """size x size, logo ingrandito di `scale` (intero: pixel nitidi) e centrato su sfondo carta; ritorna righe RGB."""
    px = [[BG] * size for _ in range(size)]
    ox, oy = (size - W * scale) // 2, (size - H * scale) // 2
    for j, row in enumerate(ROWS):
        for i, ch in enumerate(row):
            if ch in COL:
                for dy in range(scale):
                    for dx in range(scale):
                        px[oy + j * scale + dy][ox + i * scale + dx] = COL[ch]
    return px

def png(path, px):
    n = len(px)
    raw = b''.join(b'\x00' + bytes(c for p in row for c in p) for row in px)
    def chunk(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(data)

os.makedirs(os.path.join(ROOT, 'icons'), exist_ok=True)
# (file, lato, scala): margine >= 10% per lato (zona sicura "maskable")
for name, size, scale in [('icon-192.png', 192, 8), ('icon-512.png', 512, 24), ('apple-touch-icon.png', 180, 8), ('favicon-32.png', 32, 2)]:
    png(os.path.join(ROOT, 'icons', name), render(size, scale))
    print('icons/' + name)
