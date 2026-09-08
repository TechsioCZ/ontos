/* eslint-disable unicorn/prefer-number-coercion -- The schema version is parsed as a base-10 integer by contract. tracked in: #1234 */
// eslint-disable-next-line unicorn/no-array-reduce -- Slot patches intentionally flow through the accumulated document.
export const version = Number.parseInt("3", 10);
