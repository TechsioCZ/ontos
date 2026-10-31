#!/usr/bin/env python3
"""Build the AKROS storefront Inter subsets (core + extended).

Run through the wrapper so the pinned fonttools version is used:

    node app/scripts/fonts/subset-fonts.mjs

The input is the upstream ``InterVariable-latin.woff2`` that ships in
``app/akros-storefront/src/fonts``. Two outputs are produced:

* ``InterVariable-core.woff2``   – preloaded, covers everything Czech/Slovak and
  other European copy needs on every page (ASCII, Latin-1, Latin Extended-A,
  the Latin Extended-B letters the upstream file carries, common punctuation
  and the euro sign).
* ``InterVariable-ext.woff2``    – behind ``unicode-range``, covers the rest of
  the upstream cmap (other currency and letterlike symbols, super/subscripts,
  number forms, arrows, maths, spacing modifiers, combining marks, rare
  punctuation). The browser only requests it when a page actually renders one
  of those characters.

Together the two files keep the complete non-CJK coverage of the upstream file,
so any character the current site can render still renders identically.

Both files keep the ``wght`` (400-900, the range the @font-face declares) and
``opsz`` (14-32, driven by ``font-optical-sizing: auto``) axes, the default
OpenType features that actually shape text (ccmp, locl, calt, kern, mark, mkmk)
and the original vertical metrics. Hinting was already absent upstream.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont

REPO = Path(__file__).resolve().parents[3]
FONT_DIR = REPO / "app" / "akros-storefront" / "src" / "fonts"
SOURCE = FONT_DIR / "InterVariable-latin.woff2"
CORE_OUT = FONT_DIR / "InterVariable-core.woff2"
EXT_OUT = FONT_DIR / "InterVariable-ext.woff2"
CSS_OUT = FONT_DIR / "inter-extended.generated.css"
LAYOUT = REPO / "app" / "akros-storefront" / "src" / "app" / "layout.tsx"
DECLARATION_RE = re.compile(r'(prop: "unicode-range",\s*value:\s*")([^"]*)(")')
MANIFEST_OUT = FONT_DIR / "inter-subsets.generated.json"

# Axis limits: exactly what the CSS can reach.
#   wght 400-900 – layout.tsx declares font-weight: "400 900"; anything lighter
#                  is clamped to 400 by the browser, so 100-399 is dead weight.
#   opsz 14-32   – font-optical-sizing is auto everywhere on the storefront and
#                  rendered font sizes span 8px..40px, which clamps to 14..32.
WFGT_RANGE = "400:900"

# Default-on shaping features that affect how text looks without any CSS:
#   ccmp – glyph composition/decomposition
#   locl – language-specific forms (Czech/Slovak Latin)
#   calt – contextual alternates
#   kern – pair kerning (GPOS)
#   mark, mkmk – mark attachment (GPOS)
# Everything else in the upstream file (aalt, case, cv01-cv13, dlig, dnom,
# frac, numr, ordn, pnum, salt, sinf, ss01-ss08, subs, sups, tnum, zero, cpsp)
# is off unless a page turns it on; the storefront never does
# (font-feature-settings/font-variant-* are `normal` on every element).
KEEP_FEATURES = "ccmp,locl,calt,kern,mark,mkmk"

# Core = what every page already needs. Diacritics belong here: the storefront
# is Czech, so a Latin-1/Extended-A free core would make every single page pull
# the extended file as well.
CORE_EXTRA = [
    0x00A0,  # no-break space (Czech typography, price units)
    0x2010,  # hyphen
    0x2013,  # en dash
    0x2014,  # em dash
    0x2018,  # left single quotation mark
    0x2019,  # right single quotation mark / apostrophe
    0x201A,  # single low quotation mark
    0x201C,  # left double quotation mark
    0x201D,  # right double quotation mark
    0x201E,  # double low quotation mark (Czech „uvozovky")
    0x2022,  # bullet
    0x2026,  # ellipsis
    0x20AC,  # euro sign
]

# Combining diacritical marks must live in the core, next to the letters they attach to: with the
# marks in the extended file, decomposed (NFD) input such as "e" + U+0301 is shaped by two different
# faces, so ccmp cannot compose it and GPOS cannot attach the mark - it renders as a floating accent
# instead of "é". macOS input, clipboard and CSV imports do produce NFD text.
COMBINING_MARKS = list(range(0x0300, 0x0370))


def core_codepoints(available: set[int]) -> list[int]:
    wanted = list(range(0x20, 0x7F))  # printable ASCII
    wanted += list(range(0x00A1, 0x0100))  # Latin-1 supplement (letters + symbols)
    wanted += list(range(0x0100, 0x0180))  # Latin Extended-A
    wanted += [0x0192, 0x0218, 0x0219, 0x021A, 0x021B]  # ƒ Ș ș Ț ț
    wanted += COMBINING_MARKS
    wanted += CORE_EXTRA
    return sorted({cp for cp in wanted if cp in available})


def fmt_unicode_range(codepoints: list[int]) -> str:
    """Compress codepoints into a CSS unicode-range value."""
    parts: list[str] = []
    start = prev = None
    for cp in sorted(codepoints):
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            parts.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
            start = prev = cp
    if start is not None:
        parts.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
    return ", ".join(parts)


def run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stdout.write(result.stdout[-4000:])
        sys.stderr.write(result.stderr[-4000:])
        raise SystemExit(f"command failed: {' '.join(args)}")


def subset(source_ttf: Path, target_ttf: Path, codepoints: list[int]) -> None:
    run(
        [
            sys.executable,
            "-m",
            "fontTools.subset",
            str(source_ttf),
            "--unicodes=" + ",".join(f"U+{cp:04X}" for cp in codepoints),
            f"--layout-features={KEEP_FEATURES}",
            "--no-hinting",
            "--notdef-outline",
            "--drop-tables+=DSIG",
            "--name-IDs=*",
            "--name-languages=*",
            "--no-recalc-timestamp",
            f"--output-file={target_ttf}",
        ]
    )


def limit_axes(source_ttf: Path, target_ttf: Path) -> None:
    run(
        [
            sys.executable,
            "-m",
            "fontTools.varLib.instancer",
            str(source_ttf),
            f"wght={WFGT_RANGE}",
            "--no-recalc-timestamp",
            "-o",
            str(target_ttf),
        ]
    )


def compress(source_ttf: Path, target_woff2: Path) -> None:
    run(
        [
            sys.executable,
            "-m",
            "fontTools.ttLib.woff2",
            "compress",
            str(source_ttf),
            "-o",
            str(target_woff2),
        ]
    )


def build_pair(source_ttf: Path, work: Path, codepoints: list[int], stem: str, target: Path) -> None:
    subset(source_ttf, work / f"{stem}.subset.ttf", codepoints)
    limit_axes(work / f"{stem}.subset.ttf", work / f"{stem}.axes.ttf")
    compress(work / f"{stem}.axes.ttf", target)


def describe(path: Path) -> dict[str, object]:
    font = TTFont(path)
    cmap = sorted(font.getBestCmap())
    axes = {axis.axisTag: [axis.minValue, axis.maxValue] for axis in font["fvar"].axes} if "fvar" in font else {}
    return {
        "bytes": path.stat().st_size,
        "codepoints": cmap,
        "glyphs": font["maxp"].numGlyphs,
        "axes": axes,
        "tables": sorted(font.keys()),
    }


def sync_layout_range(core_range: str) -> None:
    """next/font only accepts literal option values, so layout.tsx holds the core range inline."""
    source = LAYOUT.read_text(encoding="utf-8")
    match = DECLARATION_RE.search(source)
    if not match:
        raise SystemExit(
            f"could not find the core unicode-range declaration in {LAYOUT}; "
            'expected `prop: "unicode-range", value: "..."` inside localFont(declarations)'
        )
    if match.group(2) == core_range:
        return
    LAYOUT.write_text(
        DECLARATION_RE.sub(lambda m: f"{m.group(1)}{core_range}{m.group(3)}", source, count=1),
        encoding="utf-8",
    )
    print(f"updated    {LAYOUT.relative_to(REPO)} core unicode-range literal")


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"missing source font: {SOURCE}")

    source = TTFont(SOURCE)
    # Control codepoints (U+0000, U+007F) carry no visible glyph; leave them out
    # so the extended range only describes real text characters.
    available = {cp for cp in source.getBestCmap() if cp >= 0x20 and cp != 0x7F}
    core = core_codepoints(available)
    extended = sorted(available - set(core))
    if not core or not extended:
        raise SystemExit("core/extended split is empty")

    with tempfile.TemporaryDirectory(prefix="ontos-font-subset-") as tmp:
        work = Path(tmp)
        source_ttf = work / "Inter-source.ttf"
        run([sys.executable, "-m", "fontTools.ttLib.woff2", "decompress", str(SOURCE), "-o", str(source_ttf)])
        build_pair(source_ttf, work, core, "core", CORE_OUT)
        build_pair(source_ttf, work, extended, "ext", EXT_OUT)

    core_info = describe(CORE_OUT)
    ext_info = describe(EXT_OUT)
    for label, info, expected in (("core", core_info, core), ("extended", ext_info, extended)):
        missing = sorted(set(expected) - set(info["codepoints"]))
        if missing:
            raise SystemExit(f"{label}: lost codepoints {[hex(cp) for cp in missing]}")
        unexpected = sorted(set(info["codepoints"]) - set(expected))
        if unexpected:
            raise SystemExit(f"{label}: unexpected codepoints {[hex(cp) for cp in unexpected]}")

    core_range = fmt_unicode_range(core)
    ext_range = fmt_unicode_range(extended)
    core_bytes = core_info["bytes"]
    ext_bytes = ext_info["bytes"]
    source_bytes = SOURCE.stat().st_size

    sync_layout_range(core_range)

    CSS_OUT.write_text(
        "/* Generated by `node app/scripts/fonts/subset-fonts.mjs`; do not edit by hand. */\n"
        "/* Extended Inter coverage: only downloaded when a page renders one of these characters. */\n"
        "@font-face {\n"
        '  font-family: "Inter Variable Extended";\n'
        "  font-style: normal;\n"
        "  font-weight: 400 900;\n"
        "  font-display: swap;\n"
        '  src: url("./InterVariable-ext.woff2") format("woff2");\n'
        f"  unicode-range: {ext_range};\n"
        "}\n",
        encoding="utf-8",
    )

    MANIFEST_OUT.write_text(
        json.dumps(
            {
                "source": SOURCE.name,
                "sourceBytes": source_bytes,
                "axes": {"wght": [400, 900], "opsz": [14, 32]},
                "features": KEEP_FEATURES.split(","),
                "core": {
                    "file": CORE_OUT.name,
                    "bytes": core_bytes,
                    "glyphs": core_info["glyphs"],
                    "codepoints": len(core),
                    "unicodeRange": core_range,
                },
                "extended": {
                    "file": EXT_OUT.name,
                    "bytes": ext_bytes,
                    "glyphs": ext_info["glyphs"],
                    "codepoints": len(extended),
                    "unicodeRange": ext_range,
                },
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"source      {source_bytes:>7} B  {len(available)} codepoints")
    print(f"core        {core_bytes:>7} B  {len(core)} codepoints, {core_info['glyphs']} glyphs -> {CORE_OUT.name}")
    print(f"extended    {ext_bytes:>7} B  {len(extended)} codepoints, {ext_info['glyphs']} glyphs -> {EXT_OUT.name}")
    print(f"core range  {core_range}")
    print(f"ext range   {ext_range}")


if __name__ == "__main__":
    main()
