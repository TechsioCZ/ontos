// expect-count: 8
// Point-free hand-offs of the native serializer: the unowned contract escapes the call site.
declare const pipe: (...steps: readonly unknown[]) => unknown;
declare const values: readonly unknown[];
declare const v: unknown;

export const piped = pipe(v, JSON.stringify);

export const mapped = values.map(JSON.stringify);

export const typedAlias: (value: unknown) => string = JSON.stringify;

export const inObject = { serialize: globalThis.JSON.stringify };

export const inArray = [JSON.stringify];

export const asDefault = (serialize: (value: unknown) => string = JSON.stringify) => serialize(v);

export const bound = JSON.stringify.bind(null);

export const invoked = JSON.stringify.call(null, v);
