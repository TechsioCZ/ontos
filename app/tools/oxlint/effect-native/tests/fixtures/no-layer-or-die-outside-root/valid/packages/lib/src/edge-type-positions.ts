import { Layer } from 'effect';
import { orDie } from 'effect/Layer';

declare const Base: Layer.Layer<never>;

// Type-level references only: a `typeof` query is erased and converts nothing to a defect.
export type OrDieSignature = typeof orDie;
export type OrDieReturn = ReturnType<typeof orDie>;
export type NamespaceSignature = typeof Layer.orDie;
export type Boundary = typeof Base;
