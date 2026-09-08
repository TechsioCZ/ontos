// expect-count: 2
// Static spellings of the `stringify` key that are not a bare identifier or a string `Literal`.
declare const v: unknown;

export const viaTemplateKey = JSON[`stringify`](v);

export const viaAsConstKey = JSON["stringify" as const](v);
