/** `Symbol` is shadowed by a module-local factory, so the initialiser heuristic must not fire. */
const Symbol = (description: string): string => description;

const notASymbol = Symbol('@app/core-runtime/edge/not-a-symbol');

export const record = (handler: () => void): Record<string, () => void> => ({
  [notASymbol]: handler,
});

export const readSlot = (value: Record<string, () => void>): (() => void) | undefined =>
  value[notASymbol];
