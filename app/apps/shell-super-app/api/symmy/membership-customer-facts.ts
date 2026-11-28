import { CustomerProfileSourceRequestSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import { executeCustomerProfileSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-source/client';
import {
  projectCurrentMembershipCustomer,
  symmyCustomerRecordProven,
  symmyCustomerSourceRecordId,
} from '@app/shared-contracts/symmy';
import type { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { AdmitSymmyJobPayloadSchema } from '@app/symmy-integration/api/admit-symmy-job-action';
import type { SymmyGroupCustomerRows } from '@app/symmy-integration/symmy-internal-contracts';
import { Duration, Effect, Match, Option, Redacted, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { SymmyUnavailableProblemSchema, symmyUnavailableProblem } from './contract.ts';
import type { SymmyIngressProblem } from './contract.ts';
import { resolveSymmyOwnerReleaseBase } from './owner-release-transport.ts';
import {
  acquireSymmyReadAssertion,
  mapSymmyOwnerReadProblem,
  requireRouteCompany,
  requireRouteRead,
  symmyOwnerReadForbidden,
} from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

const customerFactsSchema = AdmitSymmyJobPayloadSchema.fields.groupCustomerFacts.schema;
const customerFactSchema = customerFactsSchema.fields.profiles.value;
type CustomerFacts = typeof customerFactsSchema.Type;
type CustomerFact = typeof customerFactSchema.Type;
const [currentRequestSchema] = CustomerProfileSourceRequestSchema.members;

const profileSourceRead = 'commerce.customer-context.api.customer-profile-source';
const commerceModule = 'commerce.customer-context';
const commerceAudience = 'commerce-customer-context';
const unavailable = () => Effect.fail(symmyUnavailableProblem);
const digest = (value: string) =>
  Effect.tryPromise({
    catch: (cause) =>
      Object.defineProperty(SymmyUnavailableProblemSchema.make(symmyUnavailableProblem), 'cause', { value: cause }),
    try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, 'SHA-256', new TextEncoder().encode(value)),
  }).pipe(
    Effect.timeoutOrElse({ duration: Duration.seconds(2), orElse: unavailable }),
    Effect.map((bytes) => Hex.encode(new Uint8Array(bytes))),
  );

/** Current owner evidence is read before the job Action, never accepted from the public membership body. */
export const readSymmyMembershipCustomerFacts = Effect.fn('SymmyMembershipIntake.customerFacts')(
  function* customerFacts(
    input: {
      readonly admission: SymmyIngressAdmission;
      readonly membershipRoute: typeof SymmyRouteContextResponseSchema.Type;
      readonly rows: SymmyGroupCustomerRows;
    },
    newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
  ): Effect.fn.Return<CustomerFacts, SymmyIngressProblem> {
    const { admission, membershipRoute, rows } = input;
    if (membershipRoute.replayIdempotencyDigest !== undefined) {
      return yield* unavailable();
    }
    yield* requireRouteRead(membershipRoute, commerceModule, profileSourceRead);
    const legalEntityId = yield* requireRouteCompany(membershipRoute);
    const baseUrl = yield* resolveSymmyOwnerReleaseBase(admission.apiBaseUrl, 'symmy-integration');
    // This tenant-scoped public read uses the original credential. Do not select another route proof:
    // owner reads and the final Action must remain bound to the admitted membership route.
    const customersRoute = yield* executeSymmyRouteContextWithAuthorization(
      { routeKey: 'customersBatch' },
      `Bearer ${Redacted.value(admission.assertion)}`,
      yield* newRequestIdentifier,
      { baseUrl, compositionRevision: admission.compositionRevision },
    ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
    if (
      customersRoute.tenantId !== membershipRoute.tenantId ||
      customersRoute.legalEntityId !== legalEntityId ||
      customersRoute.issuerId !== membershipRoute.issuerId ||
      customersRoute.sourceEntityKind === undefined ||
      customersRoute.replayIdempotencyDigest !== undefined
    ) {
      return yield* unavailable();
    }
    const authority = yield* Schema.decodeUnknownEffect(customerFactsSchema.fields.authority)({
      issuer: customersRoute.issuerId,
      mappingRevision: customersRoute.sourceMappingVersion,
      namespace: customersRoute.sourceNamespace,
      recordType: customersRoute.sourceEntityKind,
      route: { id: customersRoute.sourceRouteId, revision: customersRoute.sourceRouteRevision },
    }).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
    const candidates = yield* Effect.forEach(
      rows,
      Effect.fn('SymmyMembershipIntake.currentCustomer')(function* currentCustomer({ customerId }) {
        // The customer intake names the customer by the same record: one rule, shared by both.
        const recordId = yield* symmyCustomerSourceRecordId(customerId, digest);
        if (
          !(yield* symmyCustomerRecordProven(
            { ...authority, tenantId: membershipRoute.tenantId },
            customerId,
            recordId,
            digest,
          ).pipe(Effect.mapError(mapSymmyOwnerReadProblem)))
        ) {
          return yield* unavailable();
        }
        const request = yield* Schema.decodeUnknownEffect(currentRequestSchema)({
          ...authority,
          mode: 'CURRENT',
          recordId,
        }).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
        const assertion = yield* acquireSymmyReadAssertion(admission, commerceAudience, legalEntityId);
        const result = yield* executeCustomerProfileSourceWithAuthorization(
          request,
          `Bearer ${Redacted.value(assertion.assertion)}`,
          yield* newRequestIdentifier,
          { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
        ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
        return yield* Match.value(result).pipe(
          // The owner names no profile for the record: its item is refused alone.
          Match.tag('ABSENT', () => Effect.succeed(Option.none<CustomerFact>())),
          Match.tag('CURRENT', (current) => {
            const projection = projectCurrentMembershipCustomer(
              request,
              membershipRoute.tenantId,
              current,
              Schema.decodeUnknownOption(customerFactSchema),
            );
            return projection.status === 'INVALID'
              ? unavailable()
              : Effect.succeed(projection.status === 'INACTIVE' ? Option.none() : Option.some(projection.fact));
          }),
          // A fresh admission names no customer Privacy currently refuses: the request is refused whole, as a read
          // the route may not make, and nothing of that customer is planned, pinned or kept.
          Match.tag('REFUSED', () => Effect.fail(symmyOwnerReadForbidden)),
          Match.orElse(unavailable),
        );
      }),
      { concurrency: 1 },
    );
    return yield* Schema.decodeUnknownEffect(customerFactsSchema)({
      authority,
      profiles: candidates.flatMap(Option.toArray),
    }).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  },
);
