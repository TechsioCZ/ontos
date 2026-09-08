// expect-count: 2
/* oxlint-disable no-nested-ternary -- readability */
/* eslint-disable unicorn/no-array-reduce -- */

export const pick = (flag: boolean, other: boolean): string => (flag ? "a" : other ? "b" : "c");
