// expect-count: 8
// Every indirect spelling of the ambient global that the rule claims to recognise.
declare const v: unknown;

export const optionalComputed = JSON?.["stringify"](v);

export const optionalDeep = globalThis?.JSON?.stringify?.(v);

export const viaWindow = window.JSON.stringify(v);

export const viaSelf = self.JSON.stringify(v);

export const viaGlobal = global.JSON.stringify(v);

export const viaComputedContainer = globalThis["JSON"].stringify(v);

export const viaNonNullCallee = JSON.stringify!(v);

export const viaCall = JSON["stringify"].apply(null, [v]);
