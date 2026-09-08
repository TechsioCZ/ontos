// expect-count: 5
declare const error: { readonly _tag: 'ReadInputValidationError' | 'ReadHandlerNotFound' };
declare const tagOf: (value: unknown) => string;

/** Destructuring the tag into a local does not change the classifier. */
export const viaDestructuring = (): string => {
  const { _tag } = error;
  switch (_tag) {
    case 'ReadInputValidationError': {
      return 'invalid';
    }
    case 'ReadHandlerNotFound': {
      return 'missing';
    }
  }
};

/** Renaming it while destructuring does not either. */
export const viaRenamedDestructuring = (): string => {
  const { _tag: classification } = error;
  switch (classification) {
    case 'ReadInputValidationError': {
      return 'invalid';
    }
    case 'ReadHandlerNotFound': {
      return 'missing';
    }
  }
};

/** A local alias is still a closed vocabulary. */
export const viaLocalAlias = (): string => {
  const tag = error._tag;
  switch (tag) {
    case 'ReadInputValidationError': {
      return 'invalid';
    }
    case 'ReadHandlerNotFound': {
      return 'missing';
    }
  }
};

/** Laundering the tag through `String()`. */
export const viaStringWrapper = (): string => {
  switch (String(error._tag)) {
    case 'ReadInputValidationError': {
      return 'invalid';
    }
    case 'ReadHandlerNotFound': {
      return 'missing';
    }
    default: {
      return 'internal';
    }
  }
};

/** Laundering it through a re-exported helper. */
export const viaHelper = (): string => {
  switch (tagOf(error)) {
    case 'ReadInputValidationError': {
      return 'invalid';
    }
    case 'ReadHandlerNotFound': {
      return 'missing';
    }
    default: {
      return 'internal';
    }
  }
};
