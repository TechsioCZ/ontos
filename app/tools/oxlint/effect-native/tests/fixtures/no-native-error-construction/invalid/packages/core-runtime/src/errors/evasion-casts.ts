// expect-count: 4
// Transparent TypeScript wrappers around the constructor reference.
type Ctor = new (message: string) => object;

export const viaSatisfies = new (Error satisfies Ctor)("satisfies wrapper");

export const viaNonNull = new (Error!)("non-null wrapper");

export const viaAngle = new (<Ctor>TypeError)("angle-bracket assertion");

export const viaParens = new ((((RangeError))))("redundant parentheses");
