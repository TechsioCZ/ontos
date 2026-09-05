// expect-count: 1
export interface Envelope {
  readonly payload: {
    readonly inner: {
      readonly outcome: { readonly _tag: 'deep' };
    };
  };
}
