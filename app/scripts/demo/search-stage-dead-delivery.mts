#!/usr/bin/env node
// Uses the existing exact-delivery audited operator. No bulk replay or automatic release.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import { main } from '../outbox-dead-delivery.mts';

NodeRuntime.runMain(Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped));
