import {
  CustomerGroupDefinitionSourceApi,
  CustomerGroupDefinitionSourceRequestSchema,
} from '@app/commerce-customer-context/api/customer-group-definition-source';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { SymmyCustomerGroupDefinitionFactsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import type {
  SymmyCustomerGroupDefinitionFacts,
  SymmyCustomerGroupRows,
} from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Match, Option, Redacted, Schema } from 'effect';

import { symmyUnavailableProblem } from './contract.ts';
import type { SymmyIngressProblem } from './contract.ts';
import { acquireSymmyReadAssertion, mapSymmyOwnerReadProblem, requireRouteRead } from './source-read-projections.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

type RequestIdentifier = Effect.Effect<string, typeof symmyUnavailableProblem>;

const customerContextModule = 'commerce.customer-context';
const customerContextAudience = 'commerce-customer-context';
const customerContextApiPrefix = '/commerce-customer-context-api';
const definitionSourceRead = 'commerce.customer-context.api.customer-group-definition-source';
const unavailable = () => Effect.fail(symmyUnavailableProblem);

export interface SymmyCustomerGroupFactsInput {
  readonly admission: SymmyIngressAdmission;
  readonly groups: SymmyCustomerGroupRows;
  /** The scope of the customer groups route: the source and the route authority its definitions are bound under. */
  readonly routeScope: SymmySourceReadScope;
}

/**
 * What the Commerce owner holds for each group code of the route's own source: the group the code is bound to, its
 * revision, business code and meaning, and the order of the binding's last assertion. A code the source never bound
 * has no fact and becomes a create. Reading needs the route to enroll the definition source read (403 without it); an
 * answer about another source or tenant is never taken as a fact.
 */
export const readSymmyCustomerGroupDefinitionFacts = Effect.fn('SymmyCustomerGroupBatch.definitionFacts')(
  function* definitionFacts(
    input: SymmyCustomerGroupFactsInput,
    newRequestIdentifier: RequestIdentifier,
  ): Effect.fn.Return<SymmyCustomerGroupDefinitionFacts, SymmyIngressProblem> {
    const { admission, groups, routeScope } = input;
    yield* requireRouteRead(routeScope, customerContextModule, definitionSourceRead);
    const authority = {
      issuer: routeScope.issuerId,
      mappingRevision: routeScope.sourceMappingVersion ?? routeScope.mappingVersion,
      namespace: routeScope.sourceNamespace,
      route: {
        id: routeScope.sourceRouteId ?? routeScope.routeId,
        revision: routeScope.sourceRouteRevision ?? routeScope.routeRevision,
      },
    };
    const found = yield* Effect.forEach(
      groups,
      Effect.fn('SymmyCustomerGroupBatch.definitionFact')(function* readGroup({ code }) {
        const request = yield* Schema.decodeUnknownEffect(CustomerGroupDefinitionSourceRequestSchema)({
          ...authority,
          mode: 'CURRENT',
          recordId: code,
        }).pipe(Effect.catchTag('SchemaError', unavailable));
        const assertion = yield* acquireSymmyReadAssertion(
          admission,
          customerContextAudience,
          routeScope.legalEntityId,
        );
        // The governed client of the owner's published Read contract, as the generated client builds it.
        const current = yield* makeGovernedEffectBffClient(
          {
            api: CustomerGroupDefinitionSourceApi,
            credential: Redacted.make(`Bearer ${Redacted.value(assertion.assertion)}`),
            defaultApiPrefix: customerContextApiPrefix,
            requestCorrelation: yield* newRequestIdentifier,
          },
          { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
        ).pipe(
          Effect.flatMap((client) => client.customerGroupDefinitionSource.execute({ payload: request })),
          Effect.mapError(mapSymmyOwnerReadProblem),
        );
        return yield* Match.value(current).pipe(
          Match.tag('ABSENT', () => Effect.succeed(Option.none())),
          Match.tag('CURRENT', ({ group, source }) =>
            source.issuer === authority.issuer &&
            source.namespace === authority.namespace &&
            source.recordId === code &&
            group.groupRef.tenantId === routeScope.tenantId
              ? Effect.succeed(
                  Option.some({
                    businessCode: group.businessCode,
                    code,
                    groupRef: group.groupRef,
                    meaningKey: group.meaningKey,
                    revision: group.revision,
                    sourceOrder: source.order,
                  }),
                )
              : unavailable(),
          ),
          Match.orElse(unavailable),
        );
      }),
      { concurrency: 1 },
    );
    return yield* Schema.decodeUnknownEffect(SymmyCustomerGroupDefinitionFactsSchema)(
      found.flatMap(Option.toArray),
    ).pipe(Effect.catchTag('SchemaError', unavailable));
  },
);
