// Generated product artwork for Kavárna Doma (SVG, no external assets). `renderArtwork('etiopie-yirgacheffe--2')`
// picks the object (bag, tin, dripper, …) and palette from the key words; `--2` is a detail view, `--3` a
// lifestyle scene. An optional hint carries the real product name (with diacritics) for the label.

export interface ArtHint {
  readonly name?: string;
  readonly category?: string;
}

type Kind = 'bag' | 'tin' | 'dripper' | 'kettle' | 'grinder' | 'press' | 'moka' | 'mug' | 'filters' | 'scale' | 'gift';

interface Palette {
  readonly bg: string;
  readonly bg2: string;
  readonly body: string;
  readonly bodyDark: string;
  readonly label: string;
  readonly ink: string;
  readonly accent: string;
}

const fold = (value: string): string => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const hash = (value: string): number => {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const rng = (seed: number) => {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
};

const esc = (value: string): string => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

const kindOf = (text: string): Kind => {
  if (/(konvic|kettle)/u.test(text)) return 'kettle';
  if (/(mlynek|grinder)/u.test(text)) return 'grinder';
  if (/(moka|bialetti|konvick)/u.test(text)) return 'moka';
  if (/(french|aeropress|presovac|(^|[\s-])press)/u.test(text)) return 'press';
  if (/(filtr|filter)/u.test(text)) return 'filters';
  if (/(dripper|v60|prekapav|chemex|kalita)/u.test(text)) return 'dripper';
  if (/(hrnek|salek|mug|cup|sklenic)/u.test(text)) return 'mug';
  if (/(vaha|scale)/u.test(text)) return 'scale';
  if (/(darkov|sada|box|gift|predplat|kazet)/u.test(text)) return 'gift';
  if (/(caj|tea|sencha|earl|matcha|rooibos|oolong|darjeel|assam|chai|jasmin|puerh|pu-erh|mate|genmai|gyokuro|bylin|ovocn)/u.test(text)) return 'tin';
  return 'bag';
};

const ORIGIN_ACCENT: readonly (readonly [RegExp, string])[] = [
  [/etiop/u, '#e0a93b'],
  [/kolumb/u, '#c4452f'],
  [/brazil/u, '#3c8d6a'],
  [/kena|keni/u, '#a3313f'],
  [/guatem/u, '#6d4f96'],
  [/bezkof|decaf/u, '#3f73a8'],
  [/kostar|costa/u, '#d7783a'],
  [/rwand|burund/u, '#b0563c'],
  [/espresso|blend|smes/u, '#8a4b2a'],
  [/sencha|matcha|gyokuro|genmai|zelen/u, '#5f8f3e'],
  [/earl|assam|cern/u, '#2f3e6b'],
  [/rooibos|ovocn/u, '#b5532f'],
  [/darjeel/u, '#7a4a6d'],
  [/kazet/u, '#7a2e2e'],
];

const BAGS = ['#c9a27a', '#2a2420', '#efe4d2', '#b5532f', '#2f4a3a', '#23314a', '#4a2b3c'];
const TINS = ['#2f4a3a', '#7a2e2e', '#23314a', '#d8c3a5', '#3b3b3b', '#5a3e2b'];
const CERAMICS = ['#f4efe7', '#e9ddd0', '#2b2522', '#c86f4a', '#9fb0a0'];
const BGS: readonly (readonly [string, string])[] = [
  ['#f6eadb', '#ecd7bf'],
  ['#efe6da', '#e1d2bf'],
  ['#f3e3d3', '#e7c9ad'],
  ['#e9eadf', '#d8dbc7'],
  ['#f1e4e0', '#e3cbc3'],
];

const paletteOf = (key: string, text: string, kind: Kind): Palette => {
  const h = hash(key);
  const [bg, bg2] = BGS[h % BGS.length];
  const origin = ORIGIN_ACCENT.find(([pattern]) => pattern.test(text))?.[1];
  const accent = origin ?? ['#c07a3a', '#b5532f', '#3c8d6a', '#6d4f96', '#2f3e6b'][h % 5];
  const pool = kind === 'bag' ? BAGS : kind === 'tin' ? TINS : CERAMICS;
  const body = kind === 'tin' && origin !== undefined ? shade(origin, -0.3) : pool[(h >>> 3) % pool.length];
  const dark = (kind === 'tin' && origin !== undefined) || ['#2a2420', '#23314a', '#2f4a3a', '#4a2b3c', '#3b3b3b', '#2b2522', '#7a2e2e', '#5a3e2b', '#b5532f'].includes(body);
  return {
    accent,
    bg,
    bg2,
    body,
    bodyDark: shade(body, -0.28),
    ink: '#2b1d16',
    label: dark ? '#f6efe4' : '#fffaf2',
  };
};

function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = (value >> shift) & 255;
    const next = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  return `#${[channel(16), channel(8), channel(0)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------------------ label text

/** Splits a product name into a big title and a smaller subtitle that fit a label. */
const labelLines = (name: string | undefined, fallback: string): { title: string; sub: string } => {
  const clean = (name ?? fallback).replace(/\s*[–-]\s*\d.*$/u, '').replace(/\s*\(.*\)\s*/gu, ' ').trim();
  let words = clean.split(/\s+/u);
  // „Japonská Sencha Kagoshima“ → title „Sencha“, sub „Japonská · Kagoshima“
  if (words.length > 1 && /[áýé]$/u.test(words[0]) && /^\p{Lu}/u.test(words[1])) {
    words = [words[1], words[0], ...words.slice(2)];
  }
  if (words.length === 1) return { sub: '', title: words[0] };
  const pair = `${words[0]} ${words[1]}`;
  const take = /^\p{Lu}/u.test(words[1]) && pair.length <= 10 ? 2 : 1;
  const sub = words.slice(take).join(' ');
  return { sub: sub.length > 26 ? `${sub.slice(0, 25).trimEnd()}…` : sub, title: words.slice(0, take).join(' ') };
};

const fit = (text: string, width: number, max: number, ratio = 0.56): number =>
  Math.max(11, Math.min(max, Math.floor(width / Math.max(1, text.length * ratio))));

const FALLBACK_TITLE: Record<Kind, string> = {
  bag: 'Výběrová káva',
  dripper: 'Překapávač',
  filters: 'Filtry',
  gift: 'Dárková sada',
  grinder: 'Mlýnek',
  kettle: 'Konvice',
  mug: 'Hrnek',
  press: 'French press',
  moka: 'Moka konvička',
  scale: 'Váha',
  tin: 'Sypaný čaj',
};

// ------------------------------------------------------------------ objects (drawn around x=400, floor y≈640)

const defs = (p: Palette, id: string): string => `
  <linearGradient id="${id}-body" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="${p.bodyDark}"/><stop offset="0.18" stop-color="${p.body}"/>
    <stop offset="0.55" stop-color="${shade(p.body, 0.12)}"/><stop offset="0.85" stop-color="${p.body}"/>
    <stop offset="1" stop-color="${p.bodyDark}"/>
  </linearGradient>
  <linearGradient id="${id}-metal" x1="0" x2="1" y1="0" y2="0">
    <stop offset="0" stop-color="#6f6a66"/><stop offset="0.3" stop-color="#d9d6d2"/><stop offset="0.55" stop-color="#f4f2ef"/>
    <stop offset="0.8" stop-color="#a9a5a1"/><stop offset="1" stop-color="#6f6a66"/>
  </linearGradient>
  <linearGradient id="${id}-coffee" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="#7a4a2a"/><stop offset="0.12" stop-color="#4a2a17"/><stop offset="1" stop-color="#22130b"/>
  </linearGradient>
  <linearGradient id="${id}-wood" x1="0" x2="1" y1="0" y2="1">
    <stop offset="0" stop-color="#b98a5e"/><stop offset="1" stop-color="#8a5f3c"/>
  </linearGradient>
  <radialGradient id="${id}-shadow" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#2b1d16" stop-opacity="0.32"/><stop offset="1" stop-color="#2b1d16" stop-opacity="0"/>
  </radialGradient>`;

const floorShadow = (id: string, width = 360, y = 646): string =>
  `<ellipse cx="400" cy="${y}" rx="${width / 2}" ry="26" fill="url(#${id}-shadow)"/>`;

const bean = (x: number, y: number, size: number, rotate: number, color = '#4a2a17'): string =>
  `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotate.toFixed(0)}) scale(${size.toFixed(2)})">
    <ellipse rx="16" ry="11" fill="${color}"/><ellipse rx="16" ry="11" fill="url(#beanShine)" opacity="0.5"/>
    <path d="M-14 1 C-6 -4, 4 5, 14 -1" stroke="#1d0f07" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  </g>`;

const leaf = (x: number, y: number, size: number, rotate: number, color: string): string =>
  `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotate.toFixed(0)}) scale(${size.toFixed(2)})">
    <path d="M0 -26 C16 -12, 16 12, 0 26 C-16 12, -16 -12, 0 -26 Z" fill="${color}"/>
    <path d="M0 -22 L0 22" stroke="${shade(color, -0.3)}" stroke-width="1.6"/>
  </g>`;

const drawBag = (p: Palette, id: string, title: string, sub: string): string => {
  const titleSize = fit(title, 180, 40, 0.6);
  const subSize = fit(sub, 180, 17, 0.52);
  const crimp = Array.from({ length: 44 }, (_, index) => `<line x1="${266 + index * 6}" y1="176" x2="${266 + index * 6}" y2="206" stroke="${p.bodyDark}" stroke-width="1.2" opacity="0.55"/>`).join('');
  return `${floorShadow(id, 380)}
  <path d="M268 214 L532 214 L552 640 Q400 660 248 640 Z" fill="url(#${id}-body)"/>
  <path d="M268 214 L300 214 L286 646 L250 640 Z" fill="#000" opacity="0.08"/>
  <path d="M500 214 L532 214 L552 640 L514 646 Z" fill="#000" opacity="0.1"/>
  <rect x="262" y="168" width="276" height="48" rx="6" fill="${p.body}"/>
  <rect x="262" y="168" width="276" height="48" rx="6" fill="#000" opacity="0.12"/>
  ${crimp}
  <circle cx="400" cy="256" r="13" fill="${p.bodyDark}"/><circle cx="400" cy="256" r="6" fill="${p.body}"/>
  <rect x="296" y="318" width="208" height="250" rx="8" fill="${p.label}"/>
  <rect x="306" y="328" width="188" height="230" rx="5" fill="none" stroke="${p.accent}" stroke-width="2"/>
  <text x="400" y="360" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="12.5" letter-spacing="3.5" fill="${p.ink}">KAVÁRNA DOMA</text>
  <g transform="translate(400 390)"><ellipse rx="11" ry="7.5" fill="${p.accent}"/><path d="M-9 1 C-4 -3, 3 3, 9 -1" stroke="${p.label}" stroke-width="1.6" fill="none"/></g>
  <text x="400" y="${448 + titleSize / 3}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${titleSize}" fill="${p.ink}">${esc(title)}</text>
  <text x="400" y="${494 + subSize / 3}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="${subSize}" fill="${p.ink}" opacity="0.85">${esc(sub)}</text>
  <line x1="350" y1="520" x2="450" y2="520" stroke="${p.accent}" stroke-width="2"/>
  <text x="400" y="545" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" letter-spacing="2.5" fill="${p.ink}" opacity="0.75">VÝBĚROVÁ KÁVA</text>
  <rect x="252" y="596" width="296" height="16" fill="${p.accent}" opacity="0.9"/>
  <path d="M286 222 L300 222 L292 630 L278 630 Z" fill="#fff" opacity="0.13"/>`;
};

const drawTin = (p: Palette, id: string, title: string, sub: string): string => {
  const titleSize = fit(title, 170, 36, 0.6);
  const subSize = fit(sub, 170, 16, 0.52);
  return `${floorShadow(id, 300)}
  <rect x="290" y="300" width="220" height="340" fill="url(#${id}-body)"/>
  <ellipse cx="400" cy="640" rx="110" ry="18" fill="${p.bodyDark}"/>
  <rect x="290" y="300" width="220" height="340" fill="url(#${id}-body)"/>
  <rect x="282" y="226" width="236" height="92" rx="6" fill="${p.bodyDark}"/>
  <rect x="282" y="226" width="236" height="92" rx="6" fill="url(#${id}-body)" opacity="0.6"/>
  <ellipse cx="400" cy="226" rx="118" ry="20" fill="${shade(p.body, 0.18)}"/>
  <ellipse cx="400" cy="226" rx="96" ry="13" fill="${p.body}"/>
  <rect x="290" y="372" width="220" height="200" fill="${p.label}"/>
  <rect x="290" y="372" width="220" height="10" fill="${p.accent}"/><rect x="290" y="562" width="220" height="10" fill="${p.accent}"/>
  <text x="400" y="408" text-anchor="middle" font-family="Georgia, serif" font-size="12" letter-spacing="3.5" fill="${p.ink}">KAVÁRNA DOMA</text>
  <g transform="translate(400 438)">${leafInline(p.accent)}</g>
  <text x="400" y="${492 + titleSize / 3}" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="${titleSize}" fill="${p.ink}">${esc(title)}</text>
  <text x="400" y="${532 + subSize / 3}" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="${subSize}" fill="${p.ink}" opacity="0.85">${esc(sub)}</text>
  <rect x="306" y="304" width="16" height="330" fill="#fff" opacity="0.14"/>`;
};

const leafInline = (color: string): string =>
  `<path d="M0 -16 C12 -6, 12 8, 0 16 C-12 8, -12 -6, 0 -16 Z" fill="${color}"/><path d="M0 -12 L0 12" stroke="#fff" stroke-width="1.2" opacity="0.7"/>`;

const drawDripper = (p: Palette, id: string): string => `${floorShadow(id, 330)}
  <ellipse cx="400" cy="612" rx="150" ry="26" fill="${p.bodyDark}"/>
  <ellipse cx="400" cy="604" rx="150" ry="26" fill="${p.body}"/>
  <ellipse cx="400" cy="604" rx="60" ry="10" fill="${p.bodyDark}" opacity="0.5"/>
  <path d="M352 560 L448 560 L440 600 L360 600 Z" fill="${p.bodyDark}"/>
  <path d="M248 300 L552 300 L452 566 L348 566 Z" fill="url(#${id}-body)"/>
  <path d="M520 360 C600 360, 610 460, 528 470" stroke="${p.body}" stroke-width="22" fill="none" stroke-linecap="round"/>
  <path d="M520 360 C600 360, 610 460, 528 470" stroke="#000" stroke-width="22" fill="none" stroke-linecap="round" opacity="0.08"/>
  <ellipse cx="400" cy="300" rx="152" ry="30" fill="${shade(p.body, 0.15)}"/>
  <ellipse cx="400" cy="302" rx="134" ry="22" fill="#5a3520"/>
  <ellipse cx="400" cy="300" rx="134" ry="20" fill="url(#${id}-coffee)"/>
  <ellipse cx="380" cy="296" rx="60" ry="7" fill="#c89a6a" opacity="0.45"/>
  ${[0, 1, 2, 3, 4].map((index) => `<path d="M${300 + index * 25} 340 Q${330 + index * 20} 450 ${370 + index * 12} 556" stroke="${p.bodyDark}" stroke-width="2" fill="none" opacity="0.25"/>`).join('')}
  <path d="M272 318 L300 318 L360 560 L350 560 Z" fill="#fff" opacity="0.16"/>`;

const drawKettle = (p: Palette, id: string): string => `${floorShadow(id, 380)}
  <path d="M330 330 C330 300, 470 300, 470 330" fill="none" stroke="${p.bodyDark}" stroke-width="16"/>
  <path d="M470 380 C580 360, 600 540, 520 600" stroke="#2b2522" stroke-width="20" fill="none" stroke-linecap="round"/>
  <path d="M300 590 C220 590, 230 430, 160 360" stroke="url(#${id}-metal)" stroke-width="20" fill="none" stroke-linecap="round"/>
  <path d="M300 590 C220 590, 230 430, 160 360" stroke="${p.body}" stroke-width="20" fill="none" stroke-linecap="round" opacity="0.6"/>
  <path d="M290 640 L280 420 Q280 360 400 356 Q520 360 520 420 L510 640 Z" fill="url(#${id}-body)"/>
  <ellipse cx="400" cy="640" rx="110" ry="14" fill="${p.bodyDark}"/>
  <path d="M330 372 Q400 330 470 372 Z" fill="${p.bodyDark}"/>
  <circle cx="400" cy="336" r="16" fill="#2b2522"/>
  <circle cx="440" cy="356" r="9" fill="#f4efe7" stroke="#2b2522" stroke-width="3"/>
  <rect x="300" y="430" width="16" height="190" rx="8" fill="#fff" opacity="0.18"/>`;

const drawGrinder = (p: Palette, id: string): string => `${floorShadow(id, 260)}
  <rect x="334" y="330" width="132" height="300" rx="18" fill="url(#${id}-metal)"/>
  <rect x="334" y="470" width="132" height="160" rx="18" fill="url(#${id}-body)"/>
  ${Array.from({ length: 12 }, (_, index) => `<line x1="${342 + index * 10}" y1="600" x2="${342 + index * 10}" y2="622" stroke="${p.bodyDark}" stroke-width="2.5"/>`).join('')}
  <ellipse cx="400" cy="330" rx="66" ry="14" fill="#d9d6d2"/>
  <rect x="394" y="270" width="12" height="62" fill="#6f6a66"/>
  <path d="M400 276 L570 250" stroke="#3b3735" stroke-width="12" stroke-linecap="round"/>
  <ellipse cx="582" cy="226" rx="20" ry="30" fill="url(#${id}-wood)"/>
  <circle cx="400" cy="276" r="13" fill="#3b3735"/>
  <rect x="346" y="340" width="12" height="280" rx="6" fill="#fff" opacity="0.25"/>`;

const drawPress = (p: Palette, id: string): string => `${floorShadow(id, 300)}
  <rect x="394" y="168" width="12" height="96" fill="#8f8b87"/>
  <circle cx="400" cy="160" r="22" fill="${p.body === '#f4efe7' ? '#2b2522' : p.body}"/>
  <path d="M310 252 L490 252 L496 278 L304 278 Z" fill="url(#${id}-metal)"/>
  <rect x="314" y="278" width="172" height="350" rx="6" fill="#ffffff" opacity="0.35" stroke="#b9b4ae" stroke-width="3"/>
  <rect x="318" y="372" width="164" height="252" fill="url(#${id}-coffee)"/>
  <rect x="318" y="366" width="164" height="14" fill="#c89a6a"/>
  <rect x="318" y="300" width="164" height="10" fill="#9a958f"/>
  <path d="M486 300 C560 300, 560 560, 486 560" stroke="${p.body === '#f4efe7' ? '#2b2522' : p.body}" stroke-width="18" fill="none"/>
  <rect x="306" y="618" width="188" height="22" rx="6" fill="url(#${id}-metal)"/>
  <rect x="330" y="290" width="12" height="320" fill="#fff" opacity="0.4"/>`;

const drawMoka = (p: Palette, id: string): string => `${floorShadow(id, 300)}
  <path d="M330 640 L470 640 L450 480 L350 480 Z" fill="url(#${id}-metal)"/>
  <rect x="340" y="466" width="120" height="18" fill="#8f8b87"/>
  <path d="M350 466 L450 466 L476 316 L324 316 Z" fill="url(#${id}-metal)"/>
  <path d="M318 316 L482 316 L470 288 L330 288 Z" fill="#c9c5c0"/>
  <circle cx="400" cy="278" r="12" fill="#2b2522"/>
  <path d="M324 316 L296 300 L330 300 Z" fill="#b9b4ae"/>
  <path d="M476 330 L540 340 L534 450 L470 440" fill="none" stroke="#2b2522" stroke-width="16" stroke-linejoin="round"/>
  <rect x="356" y="330" width="10" height="300" fill="#fff" opacity="0.35"/>`;

const drawMug = (p: Palette, id: string): string => `${floorShadow(id, 300)}
  <path d="M498 420 C580 420, 580 560, 494 560" stroke="${p.body}" stroke-width="26" fill="none"/>
  <path d="M498 420 C580 420, 580 560, 494 560" stroke="#000" stroke-width="26" fill="none" opacity="0.1"/>
  <path d="M298 380 L502 380 L494 600 Q400 640 306 600 Z" fill="url(#${id}-body)"/>
  <ellipse cx="400" cy="380" rx="102" ry="20" fill="${shade(p.body, 0.2)}"/>
  <ellipse cx="400" cy="384" rx="88" ry="14" fill="url(#${id}-coffee)"/>
  <ellipse cx="392" cy="382" rx="40" ry="5" fill="#c89a6a" opacity="0.5"/>
  <rect x="298" y="520" width="204" height="14" fill="${p.accent}" opacity="0.85"/>
  ${steam(360, 340)}${steam(410, 330)}${steam(450, 345)}
  <rect x="316" y="396" width="14" height="190" rx="7" fill="#fff" opacity="0.18"/>`;

const steam = (x: number, y: number): string =>
  `<path d="M${x} ${y} C${x - 18} ${y - 30}, ${x + 18} ${y - 60}, ${x} ${y - 92}" stroke="#ffffff" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.7"/>`;

const drawFilters = (p: Palette, id: string): string => `${floorShadow(id, 340)}
  ${[0, 1, 2, 3].map((index) => `<path d="M${250 + index * 10} ${300 + index * 22} L${550 - index * 6} ${300 + index * 22} L${440 + index * 2} ${610} L${360 + index * 4} ${610} Z" fill="${shade('#d9c3a1', index * 0.06)}" stroke="#b79f7d" stroke-width="2"/>`).join('')}
  <path d="M370 610 L430 610 L436 586 L364 586 Z" fill="#b79f7d" opacity="0.6"/>
  <rect x="330" y="420" width="140" height="70" rx="6" fill="${p.label}" stroke="${p.accent}" stroke-width="2"/>
  <text x="400" y="452" text-anchor="middle" font-family="Georgia, serif" font-size="16" font-weight="700" fill="${p.ink}">100 ks</text>
  <text x="400" y="474" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" letter-spacing="2" fill="${p.ink}">NEBĚLENÉ</text>`;

const drawScale = (p: Palette, id: string): string => `${floorShadow(id, 420, 600)}
  <rect x="210" y="470" width="380" height="120" rx="22" fill="#2b2522"/>
  <rect x="222" y="460" width="356" height="24" rx="10" fill="#4a4441"/>
  <rect x="300" y="514" width="200" height="50" rx="8" fill="#0f1b14"/>
  <text x="400" y="549" text-anchor="middle" font-family="ui-monospace, monospace" font-size="28" fill="#7fe0a4">18,0 g</text>
  <circle cx="540" cy="540" r="10" fill="${p.accent}"/>`;

const drawGift = (p: Palette, id: string): string => `${floorShadow(id, 380)}
  <rect x="250" y="380" width="300" height="250" rx="8" fill="url(#${id}-body)"/>
  <rect x="236" y="340" width="328" height="60" rx="8" fill="${p.bodyDark}"/>
  <rect x="386" y="340" width="28" height="290" fill="${p.accent}"/>
  <path d="M400 340 C340 280, 300 330, 400 340 C500 330, 460 280, 400 340" fill="none" stroke="${p.accent}" stroke-width="14"/>
  <rect x="290" y="460" width="80" height="60" rx="4" fill="${p.label}"/>
  <text x="330" y="496" text-anchor="middle" font-family="Georgia, serif" font-size="12" fill="${p.ink}">DOMA</text>`;

const drawObject = (kind: Kind, p: Palette, id: string, title: string, sub: string): string => {
  switch (kind) {
    case 'bag':
      return drawBag(p, id, title, sub);
    case 'tin':
      return drawTin(p, id, title, sub);
    case 'dripper':
      return drawDripper(p, id);
    case 'kettle':
      return drawKettle(p, id);
    case 'grinder':
      return drawGrinder(p, id);
    case 'press':
      return drawPress(p, id);
    case 'moka':
      return drawMoka(p, id);
    case 'mug':
      return drawMug(p, id);
    case 'filters':
      return drawFilters(p, id);
    case 'scale':
      return drawScale(p, id);
    case 'gift':
      return drawGift(p, id);
  }
};

// ------------------------------------------------------------------ scenes

const sceneBackground = (p: Palette, id: string): string => `
  <defs>
    <radialGradient id="${id}-bg" cx="0.5" cy="0.38" r="0.75">
      <stop offset="0" stop-color="#fffaf3"/><stop offset="0.55" stop-color="${p.bg}"/><stop offset="1" stop-color="${p.bg2}"/>
    </radialGradient>
  </defs>
  <rect width="800" height="800" fill="url(#${id}-bg)"/>
  <circle cx="400" cy="420" r="270" fill="#ffffff" opacity="0.35"/>
  <circle cx="400" cy="420" r="300" fill="none" stroke="${p.accent}" stroke-width="1.5" stroke-dasharray="2 10" opacity="0.5"/>`;

const scatter = (kind: Kind, p: Palette, seed: number, count: number, area: { x: number; y: number; w: number; h: number }): string => {
  const random = rng(seed);
  const items: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = area.x + random() * area.w;
    const y = area.y + random() * area.h;
    const size = 0.8 + random() * 1.1;
    const rotate = random() * 360;
    items.push(kind === 'tin' ? leaf(x, y, size, rotate, random() > 0.5 ? '#5f7f3e' : '#7c9a52') : bean(x, y, size, rotate, random() > 0.5 ? '#4a2a17' : '#5c341d'));
  }
  return items.join('');
};

const sceneDetail = (kind: Kind, p: Palette, id: string, seed: number, object: string): string => `
  <rect width="800" height="800" fill="${kind === 'tin' ? '#e6e9d8' : '#3a2416'}"/>
  ${kind === 'tin' || kind === 'bag' ? scatter(kind, p, seed, 70, { h: 860, w: 860, x: -30, y: -30 }) : `<rect width="800" height="800" fill="url(#${id}-wood)"/>${Array.from({ length: 14 }, (_, index) => `<path d="M0 ${index * 60 + 20} C200 ${index * 60 + 4}, 600 ${index * 60 + 40}, 800 ${index * 60 + 18}" stroke="#6e4a2e" stroke-width="2" fill="none" opacity="0.35"/>`).join('')}`}
  <circle cx="400" cy="420" r="250" fill="${p.bg}" opacity="0.93"/>
  <g transform="translate(400 430) scale(0.72) translate(-400 -430)">${object}</g>`;

const sceneLifestyle = (kind: Kind, p: Palette, id: string, object: string): string => `
  <rect width="800" height="800" fill="${p.bg}"/>
  <rect x="470" y="70" width="250" height="300" rx="6" fill="#fffaf0" opacity="0.8"/>
  <path d="M595 70 L595 370 M470 220 L720 220" stroke="${p.bg2}" stroke-width="10"/>
  <rect y="560" width="800" height="240" fill="url(#${id}-wood)"/>
  <rect y="556" width="800" height="10" fill="#6e4a2e" opacity="0.5"/>
  <g transform="translate(-60 40) scale(0.82)">${object}</g>
  <g transform="translate(560 520)">
    <ellipse cx="0" cy="104" rx="100" ry="16" fill="#2b1d16" opacity="0.2"/>
    <ellipse cx="0" cy="96" rx="96" ry="18" fill="#f4efe7"/>
    <path d="M-60 20 L60 20 L52 88 Q0 106 -52 88 Z" fill="#f4efe7"/>
    <path d="M58 34 C96 34, 96 78, 54 78" stroke="#f4efe7" stroke-width="12" fill="none"/>
    <ellipse cx="0" cy="20" rx="60" ry="12" fill="#e9ddd0"/>
    <ellipse cx="0" cy="22" rx="52" ry="8" fill="${kind === 'tin' ? '#b08a3a' : '#4a2a17'}"/>
    ${kind === 'tin' ? '' : '<path d="M-14 22 C-4 14, 6 30, 16 22" stroke="#e8cfa9" stroke-width="3" fill="none"/>'}
    ${steam(-14, -6)}${steam(16, -14)}
  </g>
  <g transform="translate(110 560)" opacity="0.9">${leaf(0, 0, 2.2, -30, '#5f7f3e')}${leaf(26, -20, 1.8, 20, '#7c9a52')}</g>`;

const categoryScene = (key: string): string => {
  const id = 'c';
  if (key === 'kategorie-caj') {
    const p = paletteOf('caj', 'sencha', 'tin');
    return `${sceneBackground(p, id)}<g transform="translate(-120 30) scale(0.85)">${drawTin(p, id, 'Sencha', 'Japonsko')}</g>
      <g transform="translate(250 60) scale(0.78)">${drawTin(paletteOf('earl', 'earl grey', 'tin'), `${id}2`, 'Earl Grey', 's chrpou')}</g>
      ${scatter('tin', p, 11, 14, { h: 120, w: 700, x: 50, y: 660 })}`;
  }
  if (key === 'kategorie-vybaveni') {
    const p = paletteOf('vybaveni', 'dripper', 'dripper');
    return `${sceneBackground(p, id)}<g transform="translate(-150 40) scale(0.8)">${drawKettle(paletteOf('kettle', 'kettle', 'kettle'), `${id}2`)}</g>
      <g transform="translate(220 120) scale(0.72)">${drawDripper(p, id)}</g>`;
  }
  if (key === 'kategorie-darky') {
    const p = paletteOf('darky', 'darkova', 'gift');
    return `${sceneBackground(p, id)}<g transform="translate(-120 50) scale(0.8)">${drawGift(p, id)}</g>
      <g transform="translate(250 90) scale(0.74)">${drawBag(paletteOf('kava2', 'kolumbie', 'bag'), `${id}2`, 'Objevitel', 'tři země původu')}</g>`;
  }
  if (key === 'kategorie-mleta') {
    const p = paletteOf('mleta', 'espresso', 'bag');
    return `${sceneBackground(p, id)}<g transform="translate(-130 30) scale(0.82)">${drawBag(p, id, 'Espresso', 'mletá káva')}</g>
      <g transform="translate(260 170) scale(0.66)">${drawMug(paletteOf('mug', 'hrnek', 'mug'), `${id}2`)}</g>
      <ellipse cx="400" cy="700" rx="200" ry="26" fill="#4a2a17" opacity="0.85"/><ellipse cx="400" cy="692" rx="150" ry="16" fill="#6b3f22"/>`;
  }
  const p = paletteOf('kava', 'etiopie', 'bag');
  return `${sceneBackground(p, id)}<g transform="translate(-130 30) scale(0.82)">${drawBag(p, id, 'Etiopie', 'Yirgacheffe')}</g>
    <g transform="translate(240 70) scale(0.78)">${drawBag(paletteOf('kava2', 'kolumbie', 'bag'), `${id}2`, 'Kolumbie', 'Huila')}</g>
    ${scatter('bag', p, 7, 16, { h: 110, w: 700, x: 50, y: 670 })}`;
};

const heroScene = (): string => {
  const p = paletteOf('hero', 'etiopie', 'bag');
  return `<rect width="800" height="800" fill="#2b1d16"/>
    <circle cx="420" cy="400" r="320" fill="#3a2719"/>
    <circle cx="420" cy="400" r="250" fill="#47301f"/>
    ${scatter('bag', p, 3, 26, { h: 800, w: 800, x: 0, y: 0 })}
    <g transform="translate(-40 10) scale(0.92)">${drawBag(p, 'h', 'Etiopie', 'Yirgacheffe')}</g>
    <g transform="translate(300 160) scale(0.68)">${drawMug(paletteOf('mug', 'hrnek', 'mug'), 'h2')}</g>`;
};

const CATEGORY_PALETTES: Record<string, readonly [Palette, Palette]> = {
  'kategorie-caj': [paletteOf('caj', 'sencha', 'tin'), paletteOf('earl', 'earl grey', 'tin')],
  'kategorie-darky': [paletteOf('darky', 'darkova', 'gift'), paletteOf('kava2', 'kolumbie', 'bag')],
  'kategorie-mleta': [paletteOf('mleta', 'espresso', 'bag'), paletteOf('mug', 'hrnek', 'mug')],
  'kategorie-vybaveni': [paletteOf('vybaveni', 'dripper', 'dripper'), paletteOf('kettle', 'kettle', 'kettle')],
};

const wrap = (inner: string, extraDefs: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800" role="img">
  <defs>${extraDefs}<radialGradient id="beanShine" cx="0.35" cy="0.3" r="0.7"><stop offset="0" stop-color="#a26a40"/><stop offset="1" stop-color="#a26a40" stop-opacity="0"/></radialGradient></defs>
  ${inner}</svg>`;

const placeholder = (): string => `
  <rect width="800" height="800" fill="#f3ebe0"/>
  <rect x="40" y="40" width="720" height="720" rx="36" fill="none" stroke="#d4c0a8" stroke-width="4" stroke-dasharray="14 14"/>
  <g transform="translate(400 360)" fill="none" stroke="#b49a80" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <rect x="-110" y="-80" width="220" height="160" rx="18"/><circle cx="-40" cy="-22" r="22"/><path d="M-110 60 L-30 -10 L30 40 L60 15 L110 60"/>
  </g>
  <text x="400" y="540" text-anchor="middle" font-family="Georgia, serif" font-size="40" fill="#7a6556">Bez obrázku</text>
  <text x="400" y="584" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" fill="#9c8571">Katalog k produktu žádný obrázek neposkytl</text>`;

export const renderArtwork = (rawKey: string, hint: ArtHint = {}): string => {
  const [base, view] = rawKey.split('--');
  if (base === 'bez-obrazku') return wrap(placeholder(), '');
  if (base === 'hero') return wrap(heroScene(), defs(paletteOf('hero', 'etiopie', 'bag'), 'h') + defs(paletteOf('mug', 'hrnek', 'mug'), 'h2'));
  if (base.startsWith('kategorie-')) {
    const p1 = paletteOf('kava', 'etiopie', 'bag');
    return wrap(
      categoryScene(base),
      defs(CATEGORY_PALETTES[base]?.[0] ?? p1, 'c') + defs(CATEGORY_PALETTES[base]?.[1] ?? paletteOf('kava2', 'kolumbie', 'bag'), 'c2'),
    );
  }
  const text = fold(`${base} ${hint.name ?? ''} ${hint.category ?? ''}`);
  const kind = kindOf(`${base} ${fold(hint.name ?? '')}`);
  const p = paletteOf(base, text, kind);
  const { title, sub } = labelLines(hint.name, FALLBACK_TITLE[kind]);
  const id = 'o';
  const object = drawObject(kind, p, id, title, hint.name === undefined ? '' : sub);
  const seed = hash(base);
  const scene = view === '2' ? sceneDetail(kind, p, id, seed, object) : view === '3' ? sceneLifestyle(kind, p, id, object) : `${sceneBackground(p, 'bg')}${object}`;
  return wrap(scene, defs(p, id));
};
