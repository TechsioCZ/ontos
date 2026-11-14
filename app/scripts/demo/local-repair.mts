/**
 * The canonical local repair: re-run the reviewed demo seed (ADR-0030).
 *
 * A demo helper that used to write one legacy SpiceDB relationship by hand has no v2 translation — a
 * hand-written tuple is reconciled away by the next Core write — so the repair is the idempotent reviewed
 * seed itself. It reads the operator environment (never a committed `.env` value), refuses anything but a
 * loopback development stack, and never touches the agent/storefront managed keys.
 */
import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Exit, Path } from 'effect';

import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';
import { resetDemoPermissions } from './reset-permissions.mts';

export const runCanonicalDemoRepair = Effect.fn('Demo.runCanonicalRepair')(function* runCanonicalDemoRepair() {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
  const provider = ConfigProvider.orElse(
    ConfigProvider.fromEnv(),
    yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') }),
  );
  const configuration = yield* resetEnvironment.parse(provider);
  const environment = resetChildEnvironment(configuration);
  yield* validateResetEnvironment(environment);
  return yield* resetDemoPermissions(environment, { skipKeys: true });
});

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(runCanonicalDemoRepair().pipe(Effect.provide(NodeServices.layer)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
