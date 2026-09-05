// `Effect.provide` and non-Effect objects named `Layer` are a different concern entirely.
import { Effect, Layer as EffectLayer } from 'effect';

import { CanvasLayer } from './canvas/layer.ts';
import { Gateway, GatewayLive, program } from './gateway.ts';

export const runnable = Effect.provide(program, GatewayLive);
export const merged = Effect.provideMerge?.(program, GatewayLive);

// A local object that merely happens to expose `provide`.
const Layer = { provide: (name: string): string => name, provideMerge: (name: string): string => name };
export const painted = Layer.provide('background');
export const repainted = Layer['provideMerge']('foreground');
const { provide } = Layer;
export const traced = provide('overlay');

// Non-effect module import shadowing the name.
export const canvas = CanvasLayer.provide('grid');

export type GatewayGraph = EffectLayer.Layer<Gateway, never, never>;
export const Panel = (): JSX.Element => <div data-provide="noop">panel</div>;
