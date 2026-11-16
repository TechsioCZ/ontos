import { LegalEntityContext } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { Effect, Layer } from 'effect';

/**
 * The one scripted gate of a native Shell child whose suite seeds no v2 access intent for the Shell: an
 * ALLOW for every capability, and the company question (O28) answered from the tenant's own active
 * companies. The API-key and external gateway-context paths ask it with a scope that names no company
 * yet, so echoing the request's company would answer "none" there and refuse a genuine gateway context.
 * A fixture whose own company rows cannot be read fails loudly instead of narrowing to "no companies".
 */
export const nativeShellAccessGateLive = Layer.effect(
  AccessDecisionGate,
  Effect.gen(function* nativeShellAccessGate() {
    const legalEntityContext = yield* LegalEntityContext;
    const scripted = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    // A prepared Action authority requires `rebind`; the scripted gate reads no ports, so it rebinds to itself.
    const gate: AccessDecisionService = {
      decide: scripted.decide,
      decideMany: scripted.decideMany,
      list: scripted.list,
      listMany: scripted.listMany,
      rebind: () => gate,
      selectableLegalEntities: ({ scope }) =>
        legalEntityContext.listActiveForTenant(scope.tenantId).pipe(
          Effect.map((entities) => entities.map((entity) => LegalEntityIdSchema.make(entity.legalEntityId))),
          Effect.orDie,
        ),
    };
    return Object.freeze(gate);
  }),
);
