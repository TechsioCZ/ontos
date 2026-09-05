// expect-count: 6
// Hand-rolled error hierarchies declared through every class form the parser accepts.
type Ctor = new (message: string) => object;

export const Anonymous = class extends TypeError {};

export class Aggregate extends globalThis.AggregateError {}

export abstract class AbstractBase extends Error {}

export class Cast extends (Error as Ctor) {}

export class Wrapped extends (TypeError) {}

export default class extends Error {}
