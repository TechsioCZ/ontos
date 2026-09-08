// API clients are not route modules; classification helpers here are out of scope.
export const classifyTransportFailure = (error: { readonly _tag: string }) =>
  error._tag === 'TransportError' ? 'transport' : 'internal';

export const failureState = (failure: { readonly _tag: string }) => failure._tag;
