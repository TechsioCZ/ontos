// Every `Cause` / `Effect` here resolves to a local binding, not to the effect import.
import { Cause, Effect } from 'effect';

declare const cause: Cause.Cause<never>;

export const caught = (): boolean => {
  try {
    return false;
  } catch (Cause: unknown) {
    return (Cause as { readonly hasDies: (c: unknown) => boolean }).hasDies(cause);
  }
};

export const destructuredParameter = ({ hasDies }: { readonly hasDies: boolean }): boolean => hasDies;

export class Holder {
  readonly Cause = { hasDies: (_: unknown): boolean => false };
  check(): boolean { return this.Cause.hasDies(cause); }
}

export const blessed = Effect.failCause(cause);
