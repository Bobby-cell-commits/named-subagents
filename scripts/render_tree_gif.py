"""Render captured tmux frames (capture-pane -e) into assets/demo.gif.

Capture (a private tmux server, fresh session, plugin installed):
    T="tmux -L nsdemo -f /dev/null"
    $T new-session -d -s d -x 112 -y 34 -c "$DIR"; $T set -s focus-events on
    $T send-keys -t d "claude --model haiku" Enter      # accept the trust prompt
    $T send-keys -t d -l "<prompt>"; $T capture-pane -e -p -t d > rec/000-typed.ans
    $T send-keys -t d Enter
    for i in $(seq -w 1 60); do sleep 0.5; $T capture-pane -e -p -t d > rec/f$i.ans; done
Render:
    python3 scripts/render_tree_gif.py rec assets/demo.gif
The frame list near the bottom picks which captured frames to use.
Fonts: JetBrains Mono NL Nerd Font, DejaVu Sans, Noto Color Emoji.

Keeps only real captured lines: the transcript region (above the input box) and
the task-tree rows (from '● main' down). The banner (path, session link) and the
status line (usage, paths) are left out. Frame timing is chosen for readability.
"""

import os
import re
import sys
import unicodedata
from PIL import Image, ImageDraw, ImageFont

SRC, DST = sys.argv[1], sys.argv[2]
COLS, TOP_ROWS = 112, 17
FONT = "/home/bogdan/.local/share/fonts/JetBrainsMonoNF/JetBrainsMonoNLNerdFontMono-Regular.ttf"
BOLD = FONT.replace("Regular", "Bold")
EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
FS = 15
font, bold = ImageFont.truetype(FONT, FS), ImageFont.truetype(BOLD, FS)
symfont = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", FS)
SYM = set("✢✻✽✶✳·")  # Claude Code spinner glyphs the mono font lacks
efont = ImageFont.truetype(EMOJI, 109)
CW = round(font.getlength("M"))
CH = round(FS * 1.45)
BG, FG = (30, 30, 46), (205, 214, 244)
PAD_X, PAD_Y, TITLE_H = 18, 14, 34


def x256(n):
    base = [
        (0, 0, 0),
        (205, 49, 49),
        (13, 188, 121),
        (229, 229, 16),
        (36, 114, 200),
        (188, 63, 188),
        (17, 168, 205),
        (229, 229, 229),
        (102, 102, 102),
        (241, 76, 76),
        (35, 209, 139),
        (245, 245, 67),
        (59, 142, 234),
        (214, 112, 214),
        (41, 184, 219),
        (255, 255, 255),
    ]
    if n < 16:
        return base[n]
    if n < 232:
        n -= 16
        c = [0, 95, 135, 175, 215, 255]
        return (c[n // 36], c[(n // 6) % 6], c[n % 6])
    v = 8 + (n - 232) * 10
    return (v, v, v)


OSC = re.compile(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)")
SGR = re.compile(r"\x1b\[([0-9;:]*)m")


def parse(line):
    """-> list of (char, fg, bold) with SGR applied."""
    line = OSC.sub("", line)
    out, fg, b, dim = [], FG, False, False
    pos = 0
    for m in SGR.finditer(line):
        for ch in line[pos : m.start()]:
            out.append((ch, fg, b, dim))
        ps = [int(p) if p else 0 for p in re.split("[;:]", m.group(1) or "0")]
        i = 0
        while i < len(ps):
            p = ps[i]
            if p == 0:
                fg, b, dim = FG, False, False
            elif p == 1:
                b = True
            elif p == 2:
                dim = True
            elif p == 22:
                b = dim = False
            elif p == 39:
                fg = FG
            elif 30 <= p <= 37:
                fg = x256(p - 30)
            elif 90 <= p <= 97:
                fg = x256(p - 90 + 8)
            elif p == 38 and i + 1 < len(ps):
                if ps[i + 1] == 5:
                    fg = x256(ps[i + 2])
                    i += 2
                elif ps[i + 1] == 2:
                    fg = tuple(ps[i + 2 : i + 5])
                    i += 4
            i += 1
        pos = m.end()
    for ch in line[pos:]:
        out.append((ch, fg, b, dim))
    return out


def plain(cells):
    return "".join(c[0] for c in cells)


def select(path):
    rows = [parse(ln) for ln in open(path, encoding="utf-8").read().split("\n")]
    txt = [plain(r) for r in rows]
    seps = [i for i, t in enumerate(txt) if t.startswith("────")]
    first_sep = seps[0] if seps else len(rows)
    top = [
        r
        for r, t in zip(rows[:first_sep], txt[:first_sep])
        if t.strip() and not re.match(r"\s*(▐▛|▝▜|▝▝)", t) and "tmux detected" not in t and "Tip:" not in t
    ]
    top = top[-TOP_ROWS:]
    box = rows[seps[0] : seps[1] + 1] if len(seps) >= 2 else []
    tree_i = next((i for i, t in enumerate(txt) if t.strip() == "● main"), None)
    tree = [r for r in rows[tree_i:] if plain(r).strip()] if tree_i is not None else []
    return top, box, tree


def width(ch):
    if unicodedata.category(ch) in ("Mn", "Cf") or ch == "\ufe0f":
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def is_emoji(ch):
    return ord(ch) >= 0x2300 and ch not in "─│├└┌┐┘┬┴┼●◯○❯·✻✢✽✶✳⎿▐▛▝▜█▀↓↑⏵⏸►…—–"


def draw(frame_rows, H):
    W = PAD_X * 2 + CW * COLS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, TITLE_H], fill=(24, 24, 37))
    for k, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([16 + k * 22, 11, 28 + k * 22, 23], fill=c)
    d.text((W // 2, TITLE_H // 2), "claude  ·  named-subagents 0.7.0", fill=(140, 140, 170), font=font, anchor="mm")
    y = TITLE_H + PAD_Y
    for cells in frame_rows:
        x = PAD_X
        col = 0
        skip = set()
        for j, (ch, fg, b, dim) in enumerate(cells):
            if j in skip:
                continue
            w = width(ch)
            if w == 0:
                continue
            if col >= COLS:
                break
            if dim:
                fg = tuple(int(v * 0.6 + BG[i] * 0.4) for i, v in enumerate(fg))
            if is_emoji(ch):
                g = Image.new("RGBA", (136, 128), (0, 0, 0, 0))
                ImageDraw.Draw(g).text((0, 0), ch + "\ufe0f", font=efont, embedded_color=True)
                g = g.crop(g.getbbox() or (0, 0, 1, 1)).resize((CH - 4, CH - 4), Image.LANCZOS)
                img.paste(g, (x, y + 1), g)
                # Emoji draw 2 cells wide. The terminal counted some (⌨ ✍) as 1 cell and
                # padded with 2 spaces; absorb one so every label reads "emoji name".
                rest = [c[0] for c in cells[j + 1 : j + 4] if c[0] != "\ufe0f"]
                if width(ch) == 1 and rest[:2] == [" ", " "]:
                    skip.add(next(k for k in range(j + 1, len(cells)) if cells[k][0] == " "))
                w = 2
            elif ch != " ":
                d.text((x, y), ch, fill=fg, font=symfont if ch in SYM - {"·"} else (bold if b else font))
            x += CW * w
            col += w
        y += CH
    return img


files = [os.path.join(SRC, n + ".ans") for n in ["000-typed", "f004"] + ["f%03d" % i for i in range(10, 24)]]
sel = [select(f) for f in files]
n_rows = max(len(t) + len(b) + 1 + len(tr) for t, b, tr in sel)
H = TITLE_H + PAD_Y * 2 + CH * n_rows
frames, durs, last = [], [], None
for f, (top, box, tree) in zip(files, sel):
    rows = top + box + ([[]] if tree else []) + tree
    key = "\n".join(plain(r) for r in rows)
    if key == last:
        durs[-1] += 500
        continue
    last = key
    frames.append(draw(rows, H))
    durs.append(500)
    n_named = sum(1 for r in tree if plain(r).lstrip().startswith("◯"))
    if n_named == 3:
        durs[-1] = max(durs[-1], 1400)
durs[0] = 1800
durs[-1] = 3500
frames[0].save(DST, save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=True)
print(len(frames), "frames", sum(durs) / 1000, "s", frames[0].size, os.path.getsize(DST) // 1024, "KB")
