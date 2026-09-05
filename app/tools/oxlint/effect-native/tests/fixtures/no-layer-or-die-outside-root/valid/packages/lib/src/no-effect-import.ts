import { Layer } from './local-layer.ts';

declare const target: unknown;

// `Layer` here is a project-local module, not `effect`.
export const value = Layer.orDie(target);
