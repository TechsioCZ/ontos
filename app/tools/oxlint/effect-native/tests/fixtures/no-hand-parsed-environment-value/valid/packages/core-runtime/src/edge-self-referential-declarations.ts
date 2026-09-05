// Recursion guards: self-referential and mutually-referential declarators must terminate rather
// than blow the stack while the declarator walk resolves an identifier.
declare const seed: string;

const first: string = second;
const second: string = first;
const loop: string = loop;

export const values = [Number(first), Number(second), Number(loop), Number(seed)];
