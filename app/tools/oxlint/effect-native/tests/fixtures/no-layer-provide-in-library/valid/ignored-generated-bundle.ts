// Matched by the `ignore` globs (build output / generated code is never governed).
import { Layer } from 'effect';

import { GeneratedLive, GeneratedDependencyLive } from './generated.ts';

export const BundleLive = GeneratedLive.pipe(Layer.provide(GeneratedDependencyLive));
