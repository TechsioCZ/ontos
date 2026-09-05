import { Layer } from 'effect';

declare global {
  interface Window { fresh: boolean }
}

declare module 'effect' {
  interface UnrelatedAugmentation { fresh: number }
}

export const composed = Layer.mergeAll(Layer.empty);
