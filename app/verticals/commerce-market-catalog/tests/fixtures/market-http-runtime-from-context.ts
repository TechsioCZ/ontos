import {
  ActionRuntime,
  CoreSearchQueryRuntime,
  GatewayAssertionRedemptionService,
  ReadRuntime,
} from '@app/core-runtime';
import { OwnerActionApprovals } from '@app/core-runtime/access/approvals/owner-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { Effect, Layer } from 'effect';

import { makeCommerceMarketCatalogApiRuntime } from '../../api/index.ts';

/** Tests supply their own scoped services; production mounts its concrete retirement runtime. */
export const commerceMarketCatalogApiRuntimeFromContext = Effect.gen(
  function* commerceMarketCatalogApiRuntimeFromContext() {
    const readRuntime = yield* ReadRuntime;
    const actionRuntime = yield* ActionRuntime;
    const ownerApprovals = yield* OwnerActionApprovals;
    const redemption = yield* GatewayAssertionRedemptionService;
    const administrationAuthority = yield* AccessDecisionGate;
    const searchRuntime = yield* CoreSearchQueryRuntime;
    return makeCommerceMarketCatalogApiRuntime(
      Layer.succeed(ReadRuntime, readRuntime),
      Layer.merge(Layer.succeed(ActionRuntime, actionRuntime), Layer.succeed(OwnerActionApprovals, ownerApprovals)),
      Layer.succeed(GatewayAssertionRedemptionService, redemption),
      Layer.succeed(AccessDecisionGate, administrationAuthority),
      Layer.succeed(CoreSearchQueryRuntime, searchRuntime),
    );
  },
);
