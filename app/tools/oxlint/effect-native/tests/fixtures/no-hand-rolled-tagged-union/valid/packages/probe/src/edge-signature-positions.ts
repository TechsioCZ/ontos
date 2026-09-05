export interface Listener {
  on(event: { readonly _tag: 'ready' }): void;
  readonly handler: (event: { readonly _tag: 'closed' }) => void;
  new (seed: { readonly _tag: 'seed' }): Listener;
}

export declare function handle(input: { readonly _tag: 'input' }): void;
export declare const seed: { readonly _tag: 'seed' };
export type Ctor = new (input: { readonly _tag: 'ctor' }) => Listener;
