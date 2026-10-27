// Node host composition root; imported only by server/modern.server.ts.
import {
  Context,
  Data,
  Duration,
  Effect,
  Function as Fn,
  Layer,
  Logger,
  ManagedRuntime,
  References,
  Tracer,
} from 'effect';
import type { Schema } from 'effect';

import type { handleOAuthMetadata, handleRootRoute } from '../../api/index.ts';

import { preloadModule } from '../../server/root-routes.ts';

interface ShellBff {
  readonly handleOAuthMetadata: typeof handleOAuthMetadata;
  readonly handleRootRoute: typeof handleRootRoute;
}

export const SHELL_HTTP_BUDGET = Duration.seconds(30);

const ShellBffLoadError = Data.TaggedError('ShellBffLoadError')<{
  readonly cause: Schema.Defect['Type'];
}>;

const loadShellBff = Effect.tryPromise({
  catch: (cause) => new ShellBffLoadError({ cause }),
  try: Fn.flow(
    () =>
      Promise.resolve.bind<typeof Promise, [ShellBff | PromiseLike<ShellBff>], [], Promise<ShellBff>>(
        Promise,
        import('../../api/index.ts'),
      ),
    Fn.apply({}),
  ),
}).pipe(Effect.timeout(SHELL_HTTP_BUDGET));

class ShellBffModule extends Context.Service<
  ShellBffModule,
  Effect.Effect<Effect.Success<typeof loadShellBff>, Effect.Error<typeof loadShellBff>>
>()('@app/shell-super-app/runtime/shell-server-runtime/ShellBffModule') {}

// This host runtime owns the shared import and releases its layer scope when Node shuts down.
export const shellServerRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    Layer.effect(ShellBffModule, preloadModule(loadShellBff)),
    Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
    Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
    Layer.succeed(References.MinimumLogLevel, 'Info'),
  ),
);
export const shellBff = ShellBffModule.pipe(Effect.flatten);
