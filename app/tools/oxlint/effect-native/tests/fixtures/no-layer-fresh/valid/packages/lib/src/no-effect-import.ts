import { Layer } from './local-layer.ts';
import { fresh } from './local-cache.ts';

declare const target: unknown;

// `Layer` and `fresh` here come from project-local modules, not from `effect`.
export const local = Layer.fresh(target);
export const localFresh = fresh(target);
