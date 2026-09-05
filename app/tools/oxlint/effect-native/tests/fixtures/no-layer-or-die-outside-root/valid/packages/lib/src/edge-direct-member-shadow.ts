import { orDie } from 'effect/Layer';

declare const Base: unknown;

// The import exists, but none of these names are it.
export const fromParameter = (orDie: (value: unknown) => unknown): unknown => orDie(Base);
export const fromDestructuredParameter = ({ orDie }: { orDie: (value: unknown) => unknown }): unknown => orDie(Base);
export const literalKey = { orDie: true } as const;
export const computedKey = { ['orDie']: true } as const;
export const readBack = literalKey.orDie;

export class Holder {
  orDie = 1;
  static orDie = 2;
  runOrDie(): number {
    return this.orDie;
  }
}
