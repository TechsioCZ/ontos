// expect-count: 4
type IdentityRuntimeError =
  | { readonly _tag: 'ReadInputValidationError' }
  | { readonly _tag: 'ReadHandlerNotFound' }
  | { readonly _tag: 'ActionPermissionDenied'; readonly reason: { readonly _tag: 'policy' | 'scope' } };

declare const invalid: () => string;
declare const notFound: () => string;
declare const forbidden: () => string;
declare const internal: () => string;

/** A4: the endpoint's Problem classifier is a hand-rolled switch over the error union. */
export const identityProblem = (error: IdentityRuntimeError): string => {
  switch (error._tag) {
    case 'ReadInputValidationError': {
      return invalid();
    }
    case 'ReadHandlerNotFound': {
      return notFound();
    }
    case 'ActionPermissionDenied': {
      return forbidden();
    }
  }
};

/** Nested tag access still dispatches on `_tag`. */
export const denialProblem = (error: {
  readonly reason: { readonly _tag: 'policy' | 'scope' };
}): string => {
  switch (error.reason._tag) {
    case 'policy': {
      return forbidden();
    }
    case 'scope': {
      return internal();
    }
  }
};

/** Computed access with a static key is the same classifier. */
export const computedProblem = (error: IdentityRuntimeError): string => {
  switch (error['_tag']) {
    case 'ReadInputValidationError': {
      return invalid();
    }
    default: {
      return internal();
    }
  }
};

/** Optional chaining + non-null + cast around the discriminant changes nothing. */
export const chainedProblem = (error?: IdentityRuntimeError): string => {
  switch ((error?._tag as string | undefined)!) {
    case 'ReadHandlerNotFound': {
      return notFound();
    }
    default: {
      return internal();
    }
  }
};
