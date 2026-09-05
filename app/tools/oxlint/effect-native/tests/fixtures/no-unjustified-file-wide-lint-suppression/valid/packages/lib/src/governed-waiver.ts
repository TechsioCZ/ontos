/* oxlint-disable no-nested-ternary -- The legal-entity context owns one closed three-state expression. remove-when: A9 browser runtime lands */
/* eslint-enable no-nested-ternary */

export const state = (a: boolean, b: boolean): string => (a ? "x" : b ? "y" : "z");
