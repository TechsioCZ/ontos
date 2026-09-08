// expect-count: 2
type ScaffoldError = { readonly _tag: 'TemplateMissing' } | { readonly _tag: 'WriteFailed' };

declare const argv: string;
declare const scaffoldError: ScaffoldError;

/** A8: generated/operational scripts emit the same manual error switch. */
export const explain = (): string => {
  switch (scaffoldError._tag) {
    case 'TemplateMissing': {
      return 'missing template';
    }
    case 'WriteFailed': {
      return 'write failed';
    }
    default: {
      const exhaustive: never = scaffoldError;
      return exhaustive;
    }
  }
};

/** B3: a hand-rolled argv classifier; `allowExhaustive` is off by default, so the guard does not excuse it. */
export const command = (): string => {
  switch (argv) {
    case 'generate': {
      return 'generate';
    }
    case 'validate': {
      return 'validate';
    }
    default: {
      return 'help';
    }
  }
};
