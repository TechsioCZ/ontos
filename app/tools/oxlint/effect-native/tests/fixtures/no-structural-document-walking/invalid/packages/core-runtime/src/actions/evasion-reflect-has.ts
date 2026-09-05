// expect-count: 1
/** `Reflect.has(document, 'verticals')` is `'verticals' in document` under another name. */
export const hasVerticals = (document: object): boolean => Reflect.has(document, 'verticals');
