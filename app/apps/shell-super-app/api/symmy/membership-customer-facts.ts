import { CustomerProfileSourceRequestSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import type { CustomerProfileSourceResponse } from '@app/commerce-customer-context/api/customer-profile-source';
import { executeCustomerProfileSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-source/client';
import { symmyCustomerSourceRecordId } from '@app/shared-contracts/symmy';
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
type CurrentProfile = Extract<CustomerProfileSourceResponse, { readonly _tag: 'CURRENT' }>;
const [currentRequestSchema] = CustomerProfileSourceRequestSchema.members;
type CurrentRequest = typeof currentRequestSchema.Type;

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

/**
 * The fact of one current profile, when it is exactly the queried customer source's, of the route's tenant, active
 * and of the kind it states. Anything else is not evidence about the customer and admits nothing.
 */
const currentFact = Effect.fn('SymmyMembershipIntake.currentFact')(function* currentFact(
  { item }: CurrentProfile,
  request: CurrentRequest,
  tenantId: string,
): Effect.fn.Return<Option.Option<CustomerFact>, SymmyIngressProblem> {
  const { partyRef, profile, source } = item;
  if (
    source.issuer !== request.issuer ||
    source.namespace !== request.namespace ||
    source.recordType !== request.recordType ||
    source.recordId !== request.recordId ||
    source.mappingRevision !== request.mappingRevision ||
    source.route.id !== request.route.id ||
    source.route.revision !== request.route.revision ||
    profile.profileRef.tenantId !== tenantId ||
    partyRef.tenantId !== tenantId ||
    profile.state !== 'ACTIVE' ||
    profile.subject.kind !== profile.profileRef.kind ||
    (profile.profileRef.kind === 'COUNTERPARTY' && item.icoAuthority === undefined)
  ) {
    return yield* unavailable();
  }
  const fact = yield* Schema.decodeUnknownEffect(customerFactSchema)({
    customerSource: source,
    processingKind: item.icoAuthority === 'ORGANIZATION' ? 'ORG_BUSINESS_REFERENCE' : 'PERSONAL',
    profile: { profileKind: profile.profileRef.kind, profileRef: profile.profileRef },
  }).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  return Option.some(fact);
});

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
          Match.tag('CURRENT', (current) => currentFact(current, request, membershipRoute.tenantId)),
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
