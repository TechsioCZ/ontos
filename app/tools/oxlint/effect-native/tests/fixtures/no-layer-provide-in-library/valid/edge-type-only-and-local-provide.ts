// A type-only `Layer` import plus locally defined / locally imported `provide` helpers.
// None of these are the effect `Layer.provide` escape hatch.
import type { Layer } from 'effect';

import { provide as provideCanvas } from './canvas/layer.ts';
import { Gateway } from './gateway.ts';

export type GatewayGraph = Layer.Layer<Gateway>;

const provide = (name: string): string => name;
const provideMerge = (name: string): string => `${name}!`;

export const painted = provide('grid');
export const repainted = provideMerge('grid');
export const canvas = provideCanvas('grid');
