// expect-count: 5
declare const error: {
  readonly _tag: 'A' | 'B';
  readonly reason: { readonly _tag: 'policy' | 'scope' };
};
declare const maybe: { readonly _tag: 'A' | 'B' } | undefined;
declare const load: (() => { readonly _tag: 'A' | 'B' }) | undefined;

/** `satisfies` wrapped around the object does not change what is dispatched on. */
export const viaSatisfies = (): string => {
  switch ((error satisfies { readonly _tag: string; readonly reason: unknown })._tag) {
    case 'A': {
      return 'a';
    }
    case 'B': {
      return 'b';
    }
  }
};

/** Angle-bracket type assertion around the whole discriminant. */
export const viaAngleAssertion = (): string => {
  switch (<'A' | 'B'>error._tag) {
    case 'A': {
      return 'a';
    }
    case 'B': {
      return 'b';
    }
  }
};

/** Computed access whose key is an interpolation-free template literal. */
export const viaTemplateKey = (): string => {
  switch (maybe?.[`_tag`]) {
    case 'A': {
      return 'a';
    }
    default: {
      return 'z';
    }
  }
};

/** An optional call in the object position still ends at `._tag`. */
export const viaOptionalCall = (): string => {
  switch (load?.()._tag) {
    case 'A': {
      return 'a';
    }
    default: {
      return 'z';
    }
  }
};

/** Cast plus non-null assertion inside a nested tag access. */
export const viaNestedCast = (): string => {
  switch ((error.reason as { readonly _tag: 'policy' })!._tag) {
    case 'policy': {
      return 'forbidden';
    }
    default: {
      return 'internal';
    }
  }
};
