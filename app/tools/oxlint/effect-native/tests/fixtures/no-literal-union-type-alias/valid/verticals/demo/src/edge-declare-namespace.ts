// Ambient declarations describe code we do not own, so they stay out of scope.
declare namespace LegacyGlobals {
  type Kind = 'legacy' | 'modern';
  const kind: Kind;
}

declare module 'virtual:other' {
  type Chunk = 'x' | 'y';
  export const chunk: Chunk;
}

export type LegacyKind = typeof LegacyGlobals.kind;
