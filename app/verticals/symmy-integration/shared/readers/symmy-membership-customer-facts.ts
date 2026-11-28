import { projectCurrentMembershipCustomer } from '@app/shared-contracts/symmy';
import { CustomerProfileSourceRequestSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import type {
  CustomerProfileSourceRequest,
  CustomerProfileSourceResponse,
} from '@app/commerce-customer-context/api/customer-profile-source';
import { Effect, Match, Option, Schema } from 'effect';

import {
  SymmyGroupMembershipCustomerResolutionSchema,
  SymmyGroupMembershipCustomerFactSchema,
} from '../domain/symmy-customer-group-batch.ts';
import type { SymmyGroupMembershipCustomerFact } from '../domain/symmy-customer-group-batch.ts';

export class SymmyMembershipSourceUnavailable extends Schema.TaggedError<SymmyMembershipSourceUnavailable>()(
  'SymmyMembershipSourceUnavailable',
  {},
) {}

const SymmyMembershipProfileInactive = Schema.TaggedStruct('SymmyMembershipProfileInactive', {});
/**
 * The owner answered that Privacy itself currently refuses this exact customer source: its REFUSED result and nothing
 * else. The read's forbidden problem is not this: a missing permission, module, operation context, deployment binding
 * or source route authority answers it too, and none of them says anything about the customer.
 */
const SymmyMembershipCustomerRefused = Schema.TaggedStruct('SymmyMembershipCustomerRefused', {});

const unavailable = (cause?: unknown) =>
  Object.defineProperty(new SymmyMembershipSourceUnavailable(), 'cause', { value: cause });

type CurrentRequest = Extract<CustomerProfileSourceRequest, { readonly mode: 'CURRENT' }>;
/**
 * The worker's own revalidation of a customer at dispatch. The ingress reads the same owner through its public
 * client in its own orchestration; no deployment imports this one.
 */
export const readSymmyGroupMembershipFacts = Effect.fn('SymmyMembershipIntake.readCurrent')(
  function* readSymmyGroupMembershipFacts<E, R>(input: {
    readonly authority: Omit<CurrentRequest, 'mode' | 'recordId'>;
    readonly read: (request: CurrentRequest) => Effect.Effect<CustomerProfileSourceResponse, E, R>;
    readonly recordIds: readonly string[];
    readonly tenantId: string;
  }) {
    const authority = yield* Schema.decodeUnknownEffect(SymmyGroupMembershipCustomerResolutionSchema.fields.authority)(
      input.authority,
    ).pipe(Effect.mapError(unavailable));
    const candidates = yield* Effect.forEach(
      input.recordIds,
      Effect.fn('SymmyMembershipIntake.readCustomer')(function* readCustomer(recordId: string) {
        const request = yield* Schema.decodeUnknownEffect(CustomerProfileSourceRequestSchema.members[0])({
          ...authority,
          mode: 'CURRENT',
          recordId,
        }).pipe(Effect.mapError(unavailable));
        const result = yield* input.read(request);
        return yield* Match.value(result).pipe(
          Match.tag('ABSENT', () => Effect.succeed(Option.none<SymmyGroupMembershipCustomerFact>())),
          Match.tag('REFUSED', () => Effect.fail(SymmyMembershipCustomerRefused.make({}))),
          Match.tag(
            'CURRENT',
            Effect.fn('SymmyMembershipIntake.currentFact')(function* currentFact(
              current: Extract<CustomerProfileSourceResponse, { readonly _tag: 'CURRENT' }>,
            ) {
              const projection = projectCurrentMembershipCustomer(
                request,
                input.tenantId,
                current,
                Schema.decodeUnknownOption(SymmyGroupMembershipCustomerFactSchema),
              );
              if (projection.status === 'INVALID') {
                return yield* unavailable();
              }
              if (projection.status === 'INACTIVE') {
                return yield* Effect.fail(SymmyMembershipProfileInactive.make({}));
              }
              return Option.some(projection.fact);
            }),
          ),
          Match.orElse(() => Effect.fail(unavailable())),
        );
      }),
      { concurrency: 1 },
    );
    return yield* Schema.decodeUnknownEffect(SymmyGroupMembershipCustomerResolutionSchema)({
      authority,
      profiles: candidates.flatMap(Option.toArray),
    }).pipe(Effect.mapError(unavailable));
  },
);
