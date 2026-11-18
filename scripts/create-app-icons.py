#!/usr/bin/env python3
"""Generate studio-grade Keybay application icons (Dock 1024px + Header 256px)."""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * max(0.0, min(1.0, t))


def lerp_color(c1, c2, t: float):
    t = max(0.0, min(1.0, t))
    return tuple(round(a + (b - a) * t) for a, b in zip(c1, c2))


def superellipse_mask(size: int, box, power: float = 4.6) -> Image.Image:
    """True continuous-curvature macOS squircle mask."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    rx, ry = (x1 - x0) / 2.0, (y1 - y0) / 2.0
    mask = Image.new("L", (size, size), 0)
    px = mask.load()
    # Evaluate with 1.5px smooth feather at high supersampled resolution.
    aa = 1.6 / min(rx, ry)
    start_x, end_x = max(0, int(x0 - 3)), min(size, int(x1 + 4))
    start_y, end_y = max(0, int(y0 - 3)), min(size, int(y1 + 4))
    for y in range(start_y, end_y):
        ny = abs((y + 0.5 - cy) / ry)
        if ny > 1.0 + aa:
            continue
        ny_p = ny ** power
        for x in range(start_x, end_x):
            nx = abs((x + 0.5 - cx) / rx)
            if nx > 1.0 + aa:
                continue
            d = (nx ** power + ny_p) ** (1.0 / power)
            if d <= 1.0 - aa:
                px[x, y] = 255
            elif d < 1.0 + aa:
                alpha = (1.0 + aa - d) / (2.0 * aa)
                px[x, y] = round(255 * alpha * alpha * (3 - 2 * alpha))
    return mask


def draw_cylinder_tier(
    size: int,
    cx: float,
    top_y: float,
    rx: float,
    ry: float,
    wall_h: float,
    is_top_tier: bool = False,
    tier_index: int = 0,
) -> Image.Image:
    """Render one sculpted metallic-pearl database disc with realistic horizontal light wrap."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Build the tier silhouette mask (top ellipse + vertical wall + bottom ellipse).
    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    bot_y = top_y + wall_h
    mdraw.rectangle((cx - rx, top_y, cx + rx, bot_y), fill=255)
    mdraw.ellipse((cx - rx, top_y - ry, cx + rx, top_y + ry), fill=255)
    mdraw.ellipse((cx - rx, bot_y - ry, cx + rx, bot_y + ry), fill=255)

    # Shade the cylindrical wall horizontally with pearl-titanium light wrap.
    wall = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    wpx = wall.load()
    # Slightly darker lower tiers create natural vertical depth hierarchy.
    depth_dim = 1.0 - tier_index * 0.045

    x_min, x_max = max(0, int(cx - rx - 2)), min(size, int(cx + rx + 3))
    y_min, y_max = max(0, int(top_y - ry - 2)), min(size, int(bot_y + ry + 3))

    c_left_edge = (196, 212, 244)
    c_specular = (250, 252, 255)
    c_mid = (214, 226, 250)
    c_right_shade = (146, 168, 222)
    c_right_rim = (170, 190, 238)

    for x in range(x_min, x_max):
        u = (x + 0.5 - (cx - rx)) / (2.0 * rx)
        u = max(0.0, min(1.0, u))
        if u < 0.24:
            base = lerp_color(c_left_edge, c_specular, u / 0.24)
        elif u < 0.58:
            base = lerp_color(c_specular, c_mid, (u - 0.24) / 0.34)
        elif u < 0.88:
            base = lerp_color(c_mid, c_right_shade, (u - 0.58) / 0.30)
        else:
            base = lerp_color(c_right_shade, c_right_rim, (u - 0.88) / 0.12)

        col = tuple(min(255, round(c * depth_dim)) for c in base)
        for y in range(y_min, y_max):
            vy = (y - top_y) / max(1.0, wall_h + ry)
            v_factor = 1.0 - 0.06 * max(0.0, min(1.0, vy))
            wpx[x, y] = (
                round(col[0] * v_factor),
                round(col[1] * v_factor),
                round(col[2] * v_factor),
                255,
            )

    layer.paste(wall, (0, 0), mask)

    # Top ellipse cap of this tier.
    cap_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(cap_mask).ellipse((cx - rx, top_y - ry, cx + rx, top_y + ry), fill=255)

    cap = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cpx = cap.load()
    if is_top_tier:
        cap_top = (255, 255, 255)
        cap_bot = (224, 234, 255)
    else:
        # Subtle recessed shelf shadow on lower tiers before the upper tier overlaps.
        cap_top = (168, 186, 232)
        cap_bot = (206, 220, 248)

    cy0, cy1 = max(0, int(top_y - ry - 2)), min(size, int(top_y + ry + 3))
    for y in range(cy0, cy1):
        tv = (y - (top_y - ry)) / max(1.0, 2.0 * ry)
        c = lerp_color(cap_top, cap_bot, tv)
        c = tuple(min(255, round(ch * depth_dim)) for ch in c)
        for x in range(x_min, x_max):
            cpx[x, y] = (c[0], c[1], c[2], 255)

    layer.paste(cap, (0, 0), cap_mask)

    # Crisp specular highlight rim along the front arc of the top ellipse.
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rdraw = ImageDraw.Draw(rim)
    rim_w = max(2, round(size * 0.0042))
    rdraw.arc(
        (cx - rx + rim_w * 0.5, top_y - ry + rim_w * 0.5, cx + rx - rim_w * 0.5, top_y + ry - rim_w * 0.5),
        start=8,
        end=172,
        fill=(255, 255, 255, 215 if is_top_tier else 135),
        width=rim_w,
    )
    layer = Image.alpha_composite(layer, rim)

    # Signature recessed optical platter on the crown tier.
    if is_top_tier:
        irx, iry = rx * 0.64, ry * 0.60
        well_mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(well_mask).ellipse((cx - irx, top_y - iry, cx + irx, top_y + iry), fill=255)

        well = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        well_px = well.load()
        well_top = (44, 52, 108)    # deep sapphire-indigo
        well_bot = (92, 86, 214)    # luminous indigo-violet
        well_glow = (104, 214, 255) # electric cyan core accent
        wy0, wy1 = max(0, int(top_y - iry - 2)), min(size, int(top_y + iry + 3))
        wx0, wx1 = max(0, int(cx - irx - 2)), min(size, int(cx + irx + 3))
        for y in range(wy0, wy1):
            tv = (y - (top_y - iry)) / max(1.0, 2.0 * iry)
            base_c = lerp_color(well_top, well_bot, tv)
            for x in range(wx0, wx1):
                dx = (x - (cx + irx * 0.16)) / (irx * 0.85)
                dy = (y - (top_y + iry * 0.22)) / (iry * 0.85)
                d = math.hypot(dx, dy)
                if d < 1.0:
                    k = ((1.0 - d) ** 2.0) * 0.42
                    c = lerp_color(base_c, well_glow, k)
                else:
                    c = base_c
                well_px[x, y] = (c[0], c[1], c[2], 255)
        layer.paste(well, (0, 0), well_mask)

        # Inner bevel ring around the optical platter.
        bevel = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bdraw = ImageDraw.Draw(bevel)
        bw = max(2, round(size * 0.0035))
        bdraw.arc(
            (cx - irx, top_y - iry, cx + irx, top_y + iry),
            start=185,
            end=355,
            fill=(24, 30, 68, 150),
            width=bw,
        )
        bdraw.arc(
            (cx - irx, top_y - iry, cx + irx, top_y + iry),
            start=5,
            end=175,
            fill=(255, 255, 255, 190),
            width=bw,
        )
        layer = Image.alpha_composite(layer, bevel)

    # Subtle front status indicator pill on each tier (cyan-mint active on top, cool sapphire below).
    pill = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pdraw = ImageDraw.Draw(pill)
    pill_y = top_y + ry + wall_h * 0.46
    pill_x = cx + rx * 0.46
    pill_r = size * 0.0115
    if is_top_tier:
        glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse(
            (pill_x - pill_r * 2.2, pill_y - pill_r * 2.2, pill_x + pill_r * 2.2, pill_y + pill_r * 2.2),
            fill=(56, 224, 192, 95),
        )
        glow = glow.filter(ImageFilter.GaussianBlur(radius=size * 0.008))
        layer = Image.alpha_composite(layer, glow)
        pdraw.ellipse(
            (pill_x - pill_r, pill_y - pill_r, pill_x + pill_r, pill_y + pill_r),
            fill=(42, 198, 168, 255),
        )
    else:
        pdraw.ellipse(
            (pill_x - pill_r * 0.86, pill_y - pill_r * 0.86, pill_x + pill_r * 0.86, pill_y + pill_r * 0.86),
            fill=(96, 118, 188, 175),
        )
    layer = Image.alpha_composite(layer, pill)

    return layer


TILE_COLOR = (255, 255, 255)
# Transparent inset per side on the 1024px Dock and 256px header canvases.
DOCK_MARGIN = 99.0
HEADER_MARGIN = 12.0
# Database glyph proportions as fractions of the tile width. Upright (about 0.65 wide, 0.80 tall)
# rather than wide: stretching the discs sideways to gain presence made the stack look squat.
GLYPH = {"rx": 0.325, "ry": 0.098, "wall_h": 0.140, "pitch": 0.230}


def render_icon(target_size: int, margin_ratio: float, glyph: dict | None = None) -> Image.Image:
    """Render supersampled icon and downsample cleanly with Lanczos."""
    glyph = glyph or GLYPH
    ss = 2 if target_size >= 1024 else 4
    size = target_size * ss
    margin = size * margin_ratio
    box = (margin, margin, size - margin, size - margin)
    w = box[2] - box[0]
    cx, cy = size / 2.0, size / 2.0

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    squircle = superellipse_mask(size, box, power=4.6)
    # One flat colour: no gradient, no glow, no rim light and no baked outer shadow, so the tile's
    # silhouette is exactly the squircle and measures the same as neighbouring icons.
    tile = Image.new("RGBA", (size, size), TILE_COLOR + (255,))
    tile_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile_layer.paste(tile, (0, 0), squircle)
    canvas = Image.alpha_composite(canvas, tile_layer)

    # Render the 3-tier sculpted database cylinder stack (bottom -> middle -> top).
    rx = w * glyph["rx"]
    ry = w * glyph["ry"]
    wall_h = w * glyph["wall_h"]
    pitch = w * glyph["pitch"]

    # Centre the stack's bounding box, lifted slightly to offset its cast shadow.
    top_tier_y = cy - pitch - wall_h * 0.5 - w * 0.012
    tiers_y = [top_tier_y + 2 * pitch, top_tier_y + pitch, top_tier_y]

    # Ambient drop shadow separates the light cylinder from the white tile.
    stack_union = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for idx, ty in enumerate(tiers_y):
        tier_index = 2 - idx
        is_top = idx == 2
        tier_img = draw_cylinder_tier(
            size=size,
            cx=cx,
            top_y=ty,
            rx=rx,
            ry=ry,
            wall_h=wall_h,
            is_top_tier=is_top,
            tier_index=tier_index,
        )
        if idx > 0:
            # Cast a subtle ambient occlusion shadow onto the tier below.
            ao_alpha = tier_img.getchannel("A").filter(ImageFilter.GaussianBlur(radius=size * 0.010))
            ao = Image.new("RGBA", (size, size), (12, 18, 42, 0))
            ao.putalpha(ao_alpha.point(lambda a: round(a * 0.36)))
            ao_shifted = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            ao_shifted.paste(ao, (0, round(size * 0.011)))
            # Clip AO to the already-drawn lower tiers!
            ao_clipped = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            ao_clipped.paste(ao_shifted, (0, 0), stack_union.getchannel("A"))
            stack_union = Image.alpha_composite(stack_union, ao_clipped)

        stack_union = Image.alpha_composite(stack_union, tier_img)

    glyph_shadow_alpha = stack_union.getchannel("A").filter(ImageFilter.GaussianBlur(radius=size * 0.024))
    glyph_shadow = Image.new("RGBA", (size, size), (5, 8, 20, 0))
    glyph_shadow.putalpha(glyph_shadow_alpha.point(lambda a: round(a * 0.28)))
    gs_shifted = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gs_shifted.paste(glyph_shadow, (0, round(size * 0.022)))
    gs_clipped = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gs_clipped.paste(gs_shifted, (0, 0), squircle)

    canvas = Image.alpha_composite(canvas, gs_clipped)
    canvas = Image.alpha_composite(canvas, stack_union)

    return canvas.resize((target_size, target_size), Image.Resampling.LANCZOS)


def write_svgs():
    """Vector sources generated from the same constants, so they cannot drift from the PNGs."""
    g = GLYPH

    def geometry(canvas, margin):
        w = canvas - 2 * margin
        c = canvas / 2.0
        top = c - g["pitch"] * w - g["wall_h"] * w * 0.5 - w * 0.012
        return w, c, [top + 2 * g["pitch"] * w, top + g["pitch"] * w, top], g["rx"] * w, g["ry"] * w, g["wall_h"] * w

    def tier(c, y, rx, ry, wall, fill, opacity=None, cap=None):
        d = f'M{c - rx:.1f} {y:.1f}a{rx:.1f} {ry:.1f} 0 0 1 {2 * rx:.1f} 0v{wall:.1f}a{rx:.1f} {ry:.1f} 0 0 1-{2 * rx:.1f} 0Z'
        out = f'<path d="{d}" fill="{fill}"' + (f' opacity="{opacity}"' if opacity else '') + '/>'
        return out + (f'\n    <ellipse cx="{c:.1f}" cy="{y:.1f}" rx="{rx:.1f}" ry="{ry:.1f}" fill="{cap}"/>' if cap else '')

    tile = "#%02X%02X%02X" % TILE_COLOR
    # --- 512px app icon -------------------------------------------------------------------
    canvas, margin = 512, 512 * DOCK_MARGIN / 1024
    w, c, ys, rx, ry, wall = geometry(canvas, margin)
    pill_x, pill = c + rx * 0.46, lambda y: y + ry + wall * 0.46
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tierWall" x1="{c - rx:.1f}" y1="256" x2="{c + rx:.1f}" y2="256" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C4D4F4"/>
      <stop offset=".26" stop-color="#FAFCFF"/>
      <stop offset=".6" stop-color="#D6E2FA"/>
      <stop offset=".88" stop-color="#92A8DE"/>
      <stop offset="1" stop-color="#AABEEE"/>
    </linearGradient>
    <linearGradient id="crownCap" x1="256" y1="{ys[2] - ry:.1f}" x2="256" y2="{ys[2] + ry:.1f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#E0EAFF"/>
    </linearGradient>
    <linearGradient id="platter" x1="{c - rx * 0.64:.1f}" y1="{ys[2] - ry * 0.6:.1f}" x2="{c + rx * 0.64:.1f}" y2="{ys[2] + ry * 0.6:.1f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2C346C"/>
      <stop offset=".65" stop-color="#5C56D6"/>
      <stop offset="1" stop-color="#56C8FA"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#050814" flood-opacity=".28"/>
    </filter>
  </defs>

  <rect x="{margin:.1f}" y="{margin:.1f}" width="{w:.1f}" height="{w:.1f}" rx="{w * 0.228:.1f}" fill="{tile}"/>

  <g filter="url(#drop)">
    <!-- Tier 3 (bottom) -->
    {tier(c, ys[0], rx, ry, wall, "url(#tierWall)", ".92", "#B8CAEE")}
    <circle cx="{pill_x:.1f}" cy="{pill(ys[0]):.1f}" r="5.5" fill="#6076BC" opacity=".72"/>

    <!-- Tier 2 (middle) -->
    {tier(c, ys[1], rx, ry, wall, "url(#tierWall)", ".96", "#C4D4F4")}
    <circle cx="{pill_x:.1f}" cy="{pill(ys[1]):.1f}" r="5.5" fill="#6076BC" opacity=".78"/>

    <!-- Tier 1 (top crown) -->
    {tier(c, ys[2], rx, ry, wall, "url(#tierWall)", None, "url(#crownCap)")}
    <ellipse cx="{c:.1f}" cy="{ys[2]:.1f}" rx="{rx * 0.64:.1f}" ry="{ry * 0.6:.1f}" fill="url(#platter)"/>
    <circle cx="{pill_x:.1f}" cy="{pill(ys[2]):.1f}" r="6.5" fill="#2AC6A8"/>
  </g>
</svg>
'''
    (ROOT / "src-tauri" / "icons" / "icon.svg").write_text(svg)

    # --- 64px favicon (same tile margin as the 256px in-app icon) --------------------------
    canvas, margin = 64, 64 * HEADER_MARGIN / 256
    w, c, ys, rx, ry, wall = geometry(canvas, margin)
    fav = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="wall" x1="{c - rx:.1f}" y1="32" x2="{c + rx:.1f}" y2="32" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C6D6F6"/>
      <stop offset=".28" stop-color="#FFFFFF"/>
      <stop offset=".62" stop-color="#D6E2FA"/>
      <stop offset="1" stop-color="#96ACE0"/>
    </linearGradient>
    <linearGradient id="core" x1="{c - rx * 0.64:.1f}" y1="{ys[2] - ry * 0.6:.1f}" x2="{c + rx * 0.64:.1f}" y2="{ys[2] + ry * 0.6:.1f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2D356E"/>
      <stop offset=".65" stop-color="#5E58DA"/>
      <stop offset="1" stop-color="#4EC6FA"/>
    </linearGradient>
  </defs>
  <rect x="{margin:.1f}" y="{margin:.1f}" width="{w:.1f}" height="{w:.1f}" rx="{w * 0.228:.1f}" fill="{tile}"/>

  {tier(c, ys[0], rx, ry, wall, "url(#wall)", ".9")}
  {tier(c, ys[1], rx, ry, wall, "url(#wall)", ".95")}
  {tier(c, ys[2], rx, ry, wall, "url(#wall)", None, "#F6F9FF")}
  <ellipse cx="{c:.1f}" cy="{ys[2]:.1f}" rx="{rx * 0.64:.1f}" ry="{ry * 0.6:.1f}" fill="url(#core)"/>
  <circle cx="{c + rx * 0.46:.1f}" cy="{ys[2] + ry + wall * 0.46:.1f}" r="1.1" fill="#2AC6A8"/>
</svg>
'''
    (ROOT / "src" / "favicon.svg").write_text(fav)


def main():
    # 1. Master 1024x1024 macOS/Tauri bundle icon: flat tile, no baked outer shadow.
    dock_icon = render_icon(target_size=1024, margin_ratio=DOCK_MARGIN / 1024.0)
    tauri_icon_path = ROOT / "src-tauri" / "icons" / "icon.png"
    dock_icon.save(tauri_icon_path, optimize=True)

    # 2. Crisp 256x256 in-app brand & browser icon (tight margin so 29px header glyph is bold & sharp).
    header_icon = render_icon(target_size=256, margin_ratio=HEADER_MARGIN / 256.0)
    brand_icon_path = ROOT / "src" / "assets" / "db-studio-icon.png"
    header_icon.save(brand_icon_path, optimize=True)
    write_svgs()
    print(f"Saved {tauri_icon_path}, {brand_icon_path} and both SVG sources")


if __name__ == "__main__":
    main()
