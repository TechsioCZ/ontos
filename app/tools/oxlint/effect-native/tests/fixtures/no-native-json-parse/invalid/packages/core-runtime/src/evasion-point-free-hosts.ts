// expect-count: 13
declare const s: string;
declare const lines: readonly string[];
declare function pipe<A, B>(a: A, f: (a: A) => B): B;

export const viaSelf = self.JSON.parse(s);
export const viaFrames = frames.JSON.parse(s);
export const viaWindowComputed = window["JSON"]["parse"](s);
export const viaOptionalContainer = globalThis?.JSON?.parse?.(s);
export const viaSequence = (0, JSON.parse)(s);
export const viaCall = JSON.parse.call(null, s);
export const viaBind = JSON.parse.bind(JSON);
export const viaMap = lines.map(JSON.parse);
export const viaPipe = pipe(s, JSON.parse);
export const viaNonNull = JSON!.parse(s);
export const viaSatisfies = (JSON satisfies object).parse(s);

let assigned: unknown;
({ parse: assigned } = JSON);
export const { parse: exportedParse, stringify: keptEncoder } = JSON;
export { assigned };
