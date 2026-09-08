import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer } from 'effect';
import type { Scope } from 'effect';

/** Run a CLI at its main-module edge, retaining scoped cleanup and one error reporter. */
export const runQualityCli = <Failure,>(
  command: Effect.Effect<void, Failure, NodeServices.NodeServices | Scope.Scope>,
) => {
  const mainLayer = Layer.effectDiscard(
    command.pipe(Effect.tapError((issue) => Console.error(String(issue)))),
  ).pipe(Layer.provide(NodeServices.layer));
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid), {
    disableErrorReporting: true,
  });
};
