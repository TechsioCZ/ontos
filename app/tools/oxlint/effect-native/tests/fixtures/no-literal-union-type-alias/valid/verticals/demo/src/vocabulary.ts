// An unrelated local object named `Schema` must not be mistaken for the effect namespace,
// and a non-union alias must never report regardless.
const Schema = { Literals: (values: readonly string[]) => values };
export const Status = Schema.Literals(['dead', 'pending']);
export type StatusTuple = readonly string[];

// Ambient declarations describe code we do not own (Module Federation `@mf-types`, augmentation).
declare global {
  type RemoteKeys = 'demo/PageA' | 'demo/PageB';
}

declare module 'virtual:demo' {
  type ChunkKind = 'async' | 'sync';
  export const kind: ChunkKind;
}

declare type AmbientState = 'off' | 'on';

export {};
