import { Layer } from 'effect';
import type { provide } from 'effect/Layer';
import { provideMerge } from 'effect/Layer';
export type Provide = typeof provide;
export type Merge = typeof provideMerge;
export type NamespaceProvide = typeof Layer.provide;
