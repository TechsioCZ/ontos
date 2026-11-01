# Storefront font subsets

The AKROS storefront ships one web font: Inter Variable (TrueType outlines, `wght` 100–900,
`opsz` 14–32, `glyf`/`gvar`, no hinting). The upstream file lives at
`app/akros-storefront/src/fonts/InterVariable-latin.woff2` (kept in the tree as the script input; the
app no longer references it) and is already the official Inter "Latin" subset (596 characters: ASCII, Latin-1, Latin Extended-A, part of Latin Extended-B,
typographic punctuation, super/subscripts, number forms, currency, letterlike, arrows, maths).

`subset-fonts.mjs` cuts it into the two files the app serves:

| File                       | Served how                                                                                                                    | Covers                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InterVariable-core.woff2` | preloaded by `next/font/local` in `src/app/layout.tsx`                                                                        | ASCII, Latin-1, Latin Extended-A, the Latin Extended-B letters the upstream file carries (ƒ Ș ș Ț ț), the punctuation Czech copy needs (`- – — ‘ ’ ‚ “ ” „ • …`), `€`, the combining diacritical marks U+0300–U+0327, and every character that participates in a kerning pair |
| `InterVariable-ext.woff2`  | `@font-face` behind `unicode-range` in `inter-extended.generated.css`, fetched only when a page renders one of its characters | what is left: characters the font never kerns, e.g. `‰ ‱ ⅓ ⅔ ⅷ ₀ ™ ℠ ₽ ₴ ₸ ₺ ₼` and the rarer punctuation / number forms / currency signs                                                                                                                                     |

Both files keep the axes the CSS can reach (`wght` 400–900, `opsz` 14–32), the default shaping
features (`ccmp`, `locl`, `calt`, `kern`, `mark`, `mkmk`) and the original metrics/names. All
other OpenType features (`cv01`–`cv13`, `ss01`–`ss08`, `tnum`, `zero`, `frac`, `sups`, `subs`, …)
are removed because the storefront never enables them (`font-feature-settings` and
`font-variant-*` compute to `normal` on every element). Hinting is dropped, but the upstream file
has no hinting instructions (`fpgm`/`prep`/`cvt `/`gasp` are absent), so that step is a no-op.

Together the two files still cover every character of the upstream file, so user-entered text
(product names, search queries, addresses, notes) keeps rendering with the same Inter outlines,
widths and metrics.

Two rules keep the split from changing rendering:

- **Kerning stays inside one file.** A kerned pair shaped by two faces loses its pair adjustment and
  the text shifts (measured up to +1.4 px at 28 px). The script shapes every ordered pair with
  HarfBuzz — the shaper the browser uses — and keeps every codepoint that kerns in the core, so no
  kerned pair can span the two files.
- **Combining marks sit with the letters.** With the marks in the extended file, decomposed (NFD)
  text such as `e` + U+0301 would be shaped by two faces, `ccmp` could not compose `é` and the accent
  would float. The marks therefore live in the core next to the letters.

One residual difference is known and accepted: a combining mark typed after a _symbol_ character
(for example `→` + U+0301) no longer attaches to that symbol, because base and mark end up in
different files. No realistic input produces it (it is a stress-test case only).

## When to rerun

Run the script and commit the generated files when:

- the upstream `InterVariable-latin.woff2` is replaced (new Inter release), or
- the core/extended split changes (a new character class must be available without the extra
  request), or
- the OpenType feature or axis policy changes.

The generated files are committed; normal builds never run fonttools.

## How to run

```sh
node app/scripts/fonts/subset-fonts.mjs
```

The wrapper uses [`uv`](https://docs.astral.sh/uv/) to run the pinned
`fonttools[woff]==4.59.2` and `uharfbuzz==0.51.1` in a throwaway environment, so no Python
dependency is added to the workspace. HarfBuzz is only used to find kerning pairs. If `uv` is missing, install it (`brew install uv`). `uv` caches downloads in
`~/.cache/uv`; set `UV_CACHE_DIR` if that path is not writable.

Outputs (all committed):

- `app/akros-storefront/src/fonts/InterVariable-core.woff2`
- `app/akros-storefront/src/fonts/InterVariable-ext.woff2`
- `app/akros-storefront/src/fonts/inter-extended.generated.css` — extended `@font-face` with the
  exact `unicode-range` of the file it describes
- `app/akros-storefront/src/fonts/inter-subsets.generated.json` — sizes, glyph counts, axes and
  ranges for review
- the core `unicode-range` literal inside `src/app/layout.tsx`. `next/font/local` only accepts
  literal option values, so the range cannot be imported; the script rewrites that one line when the
  subset changes, which keeps the declaration and the file in sync.

The script fails if either file is missing a codepoint that belongs to it, if a file gains a
codepoint it should not contain, or if the two sets overlap.
