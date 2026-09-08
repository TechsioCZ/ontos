/** Astral characters, escaped delimiters, nested templates and empty interpolations. The offset
 *  arithmetic must survive all of them without reporting or throwing. */
const raw = String.raw;

export const renderBanner = (locale: string): string => `
// ✅ 🚀 çéüñ — 日本語 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 😀😀😀
const label = \`\${title}: ${locale}\`;
const nested = ${`${`${"inner"}`}`}${""};
const windowsPath = ${raw`C:\unrelated\path`};
`;
