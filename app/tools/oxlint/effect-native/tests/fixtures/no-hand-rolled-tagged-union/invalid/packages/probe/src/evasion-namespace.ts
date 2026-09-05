// expect-count: 3
// Hiding the declaration inside a `namespace` block does not make it Schema-owned.
export namespace Gateway {
  export interface Timeout {
    readonly _tag: 'GatewayTimeout';
  }
  export type Outcome = { readonly _tag: 'ok' } | { readonly _tag: 'err' };
}
