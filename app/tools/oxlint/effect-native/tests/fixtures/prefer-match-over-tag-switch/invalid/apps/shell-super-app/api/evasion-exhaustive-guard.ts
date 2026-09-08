// expect-count: 2
type IdentityRuntimeError = { readonly _tag: 'A' } | { readonly _tag: 'B' };

declare const error: IdentityRuntimeError;
declare function assertNever(value: never): never;

/**
 * `allowExhaustive` is `false` by default: the audit wants these dispatchers moved onto
 * Match / catchTags, so a compiler-proven `never` guard does not excuse the switch.
 */
export const neverGuarded = (): string => {
  switch (error._tag) {
    case 'A': {
      return 'a';
    }
    case 'B': {
      return 'b';
    }
    default: {
      const exhaustive: never = error;
      return assertNever(exhaustive);
    }
  }
};

export const satisfiesGuarded = (): string => {
  switch (error._tag) {
    case 'A': {
      return 'a';
    }
    case 'B': {
      return 'b';
    }
    default: {
      return (error satisfies never) as never;
    }
  }
};
