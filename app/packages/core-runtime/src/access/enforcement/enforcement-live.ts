import { Effect, Layer, Option } from 'effect';
import type { Scope } from 'effect';
import { v1 } from '@authzed/authzed-node';

import { openSpiceDbRpc } from '../../permissions/spicedb-transaction-guard.ts';
import { loadSpiceDbConfig } from '../../permissions/config.ts';
import type { SpiceDbConfigValue } from '../../permissions/config.ts';
import { SPICEDB_CHECK_TIMEOUT_MS } from '../../permissions/client.ts';
import type { SpiceDbRpc } from '../../permissions/spicedb-rpc.ts';
import { DecisionCheck } from '../decision/engine.ts';
import type { AccessCheckPermissionship, DecisionCheckPort } from '../decision/engine.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import { toCheckBulkRequest } from '../decision/spicedb-check-port.ts';

/**
 * The engine port of the enforcement seam: one `CheckBulkPermissions` snapshot per decision, over the
 * runtime's own SpiceDB transport (gRPC on Node, the HTTP gateway on workerd). An engine that cannot
 * be configured or opened answers UNAVAILABLE, so every decision is a retryable 503 and never an
 * allow (O48b), exactly like the legacy check layers.
 *
 * `tests/unit/access-enforcement-decision-check.test.ts` holds this adaptation equal to
 * `access/decision/spicedb-check-port.ts` answer for answer, so the two can never drift (O48b, L1).
 */
const unavailableCheck = (reason: string): DecisionCheckPort => ({
  checkBulk: () => Effect.fail(accessDecisionUnavailable(reason)),
});

/**
 * One pair's answer. Only an explicit HAS or NO is an answer: a caveat the engine could not evaluate
 * is `conditional` (fail closed) and anything else — including an unspecified arm — is a per-item
 * error, which the decision engine turns into UNAVAILABLE rather than a denial.
 */
const permissionshipOf = (response: v1.CheckBulkPermissionsPair['response']): AccessCheckPermissionship => {
  if (response.oneofKind !== 'item') {
    return 'error';
  }
  const { permissionship } = response.item;
  if (permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
    return 'has';
  }
  if (permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
    return 'none';
  }
  return permissionship === v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION ? 'conditional' : 'error';
};

/** The engine port over one transport; `toCheckBulkRequest` is the compiler-owned request shape. */
export const enginePortOf = (rpc: SpiceDbRpc): DecisionCheckPort => ({
  checkBulk: (items) =>
    rpc.checkBulkPermissions(toCheckBulkRequest(items)).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The authorization engine did not answer', cause)),
      Effect.map((response): readonly { readonly permissionship: AccessCheckPermissionship }[] =>
        response.pairs.map(({ response: item }) => ({ permissionship: permissionshipOf(item) })),
      ),
    ),
});

/** One engine client for the life of the layer; the transport owns its own per-call deadline. */
const openEngine = (configuration: SpiceDbConfigValue): Effect.Effect<Option.Option<SpiceDbRpc>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.option(
      Effect.try({
        catch: (cause) => accessDecisionUnavailable('The authorization engine client could not be opened', cause),
        try: () => openSpiceDbRpc(configuration, SPICEDB_CHECK_TIMEOUT_MS),
      }),
    ),
    (opened) => (Option.isSome(opened) ? Effect.sync(() => opened.value.close()) : Effect.void),
  );

/**
 * The seam's engine port, wired to the same transport every other SpiceDB client uses. An
 * unconfigured engine stays bootable and answers a retryable 503 for every decision, never an allow:
 * `AccessDecisionLive` then reports UNAVAILABLE instead of letting the request through.
 */
export const DecisionCheckLive: Layer.Layer<DecisionCheck> = Layer.effect(
  DecisionCheck,
  Effect.gen(function* decisionCheckLive() {
    const configuration = yield* Effect.option(loadSpiceDbConfig());
    if (Option.isNone(configuration)) {
      return unavailableCheck('The authorization engine is not configured');
    }
    const opened = yield* openEngine(configuration.value);
    return Option.isNone(opened)
      ? unavailableCheck('The authorization engine client could not be opened')
      : enginePortOf(opened.value);
  }),
);
