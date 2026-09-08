// The single browser adapter seam the audit blesses: one ManagedRuntime, one cancellation-aware
// query/mutation adapter, `Layer.orDie` at the deliberate startup root. Never reported.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Effect, Layer, ManagedRuntime } from 'effect';

import { BrowserServicesLive } from '../browser-services.ts';

export const browserRuntime = ManagedRuntime.make(Layer.orDie(BrowserServicesLive));

export const useEffectQuery = <Success, Failure>(
  queryKey: ReadonlyArray<string>,
  effect: Effect.Effect<Success, Failure>,
) =>
  useQuery<Success, Failure>({
    queryFn: ({ signal }) => browserRuntime.runPromise(effect, { signal }),
    queryKey: [...queryKey],
  });

export const useEffectMutation = <Success, Failure, Input>(
  operation: (input: Input) => Effect.Effect<Success, Failure>,
) =>
  useMutation<Success, Failure, Input>({
    mutationFn: (input) => browserRuntime.runPromise(operation(input)),
  });

export const runOnceAtStartup = <Success>(effect: Effect.Effect<Success>) =>
  Effect.runFork(effect);
