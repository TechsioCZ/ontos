import {
  AddContactPointPayloadSchema,
  CreatePartyPayloadSchema,
  DuplicateCandidateDetailRequestSchema,
  PartyCommandAlreadyCommittedProblemSchema,
} from '@app/party-registry/api';
import type {
  CounterpartyCustomerOnboardResultSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  ResolveDuplicateCandidateCreatePayloadSchema,
  CreatePartyResultSchema,
  DuplicateCandidateDetailResponseSchema,
  ResolveDuplicateCandidateCreateResultSchema,
  ResolvePartyCommandCommitResultSchema,
} from '@app/party-registry/api';
import type { PartyCommandOptions, CustomerListItem } from '@app/party-registry/api/client';
import { DateTime, Effect, Schema } from 'effect';
import type { Order } from './apis/records.ts';

export class OrderCustomerConversionError extends Schema.TaggedError<OrderCustomerConversionError>()(
  'OrderCustomerConversionError',
  { reason: Schema.String, reviewCase: Schema.optionalKey(DuplicateCandidateDetailRequestSchema.fields.caseRef) },
) {}

type WriteOptions = Pick<PartyCommandOptions, 'correlationId' | 'idempotencyKey'>;
const provenanceSource = 'demo.merchandise.order-customer';

/** Both staff UI and the explicit seed operator use these same native Party owners. */
export interface OrderCustomerOwners<E, R> {
  readonly contact: (
    payload: typeof AddContactPointPayloadSchema.Type,
    options: WriteOptions,
  ) => Effect.Effect<void, E, R>;
  readonly create: (
    payload: typeof CreatePartyPayloadSchema.Type,
    options: WriteOptions,
  ) => Effect.Effect<typeof CreatePartyResultSchema.Type, E, R>;
  readonly customers: Effect.Effect<readonly CustomerListItem[], E, R>;
  readonly detail: (
    payload: typeof DuplicateCandidateDetailRequestSchema.Type,
  ) => Effect.Effect<typeof DuplicateCandidateDetailResponseSchema.Type, E, R>;
  readonly onboard: (
    payload: typeof CounterpartyCustomerOnboardPayloadSchema.Type,
    options: WriteOptions,
  ) => Effect.Effect<Pick<typeof CounterpartyCustomerOnboardResultSchema.Type, 'counterpartyRef'>, E, R>;
  readonly recover: (key: string) => Effect.Effect<typeof ResolvePartyCommandCommitResultSchema.Type, E, R>;
  readonly resolve: (
    payload: typeof ResolveDuplicateCandidateCreatePayloadSchema.Type,
    options: WriteOptions,
  ) => Effect.Effect<typeof ResolveDuplicateCandidateCreateResultSchema.Type, E, R>;
}

/** Explicit staff intent, never called by guest checkout; neither names nor e-mails prove identity. */
export const convertOrderCustomer = Effect.fn('Merchandise.convertOrderCustomer')(function* convert<E, R>(
  order: Order,
  owners: OrderCustomerOwners<E, R>,
) {
  if (order.channel !== 'STOREFRONT' || order.contact === undefined || order.demoCleanup !== undefined) {
    return yield* new OrderCustomerConversionError({ reason: 'Objednávka nemá kontakt zákazníka.' });
  }
  const root = `merchandise:order-customer:${order.id}`;
  const options = (step: string): WriteOptions => ({ correlationId: root, idempotencyKey: `${root}:${step}` });
  const evidenceReference = `merchandise:order:${order.id}`;
  // Immutable order time keeps the exact owner request stable across retries and interrupted runs.
  const validFrom = order.createdAt;
  const candidate = yield* Schema.decodeEffect(CreatePartyPayloadSchema)({
    candidate: {
      displayName: order.contact.name,
      evidenceRefs: [evidenceReference],
      officialIdentifiers: [],
      partyType: 'PERSON',
      provenance: { method: 'MANUAL_ENTRY', source: provenanceSource },
      subjectEvidence: [
        {
          basis: 'DIRECT_INTERACTION',
          evidenceRef: evidenceReference,
          kind: 'ACTOR_ATTESTATION',
          observedSubject: 'PERSON',
          statement: `Authorized staff requested customer conversion of order ${order.number}`,
          subjectKey: evidenceReference,
        },
      ],
      validFrom: DateTime.formatIso(validFrom),
    },
  });
  const recoverCreate = owners.recover(options('party').idempotencyKey).pipe(
    Effect.flatMap((commit) =>
      commit.state === 'COMMITTED' && commit.createResult !== undefined
        ? Effect.succeed(commit.createResult)
        : Effect.fail(
            new OrderCustomerConversionError({
              reason: 'Založení zákazníka zatím nemá potvrzený výsledek. Zkuste to později.',
            }),
          ),
    ),
  );
  const created = yield* owners
    .create(candidate, options('party'))
    .pipe(Effect.catchIf(Schema.is(PartyCommandAlreadyCommittedProblemSchema), () => recoverCreate));
  let partyRef;
  if (created.outcome === 'AMBIGUOUS') {
    const detail = yield* owners.detail({ caseRef: created.caseRef });
    if (detail.lifecycleState !== 'OPEN' || detail.candidateParties.length > 0) {
      return yield* new OrderCustomerConversionError({
        reason: 'Podobný zákazník už existuje. Nejdříve posuďte jeho totožnost a potom převod zopakujte.',
        reviewCase: created.caseRef,
      });
    }
    const resolved = yield* owners.resolve(
      {
        caseRef: created.caseRef,
        expectedRevision: detail.revision,
        reason: `Staff requested conversion of order ${order.number}; no candidate Party exists`,
      },
      options('resolve'),
    );
    ({ partyRef } = resolved);
  } else {
    ({ partyRef } = created);
  }
  if (partyRef === null) {
    return yield* new OrderCustomerConversionError({ reason: 'Posouzení totožnosti zatím nemá potvrzený výsledek.' });
  }
  const resolvedParty = partyRef;
  const currentCustomer = (items: readonly CustomerListItem[]) =>
    items.find((item) => item.status === 'ACTIVE' && item.partyId === resolvedParty.resourceId);
  const customerRecords = yield* owners.customers;
  const current = currentCustomer(customerRecords);
  if (current === undefined && customerRecords.length >= 500) {
    return yield* new OrderCustomerConversionError({
      reason: 'Seznam zákazníků není úplný. Převod musí dokončit správce.',
    });
  }
  const onboarded =
    current ??
    (yield* owners
      .onboard(
        {
          counterpartyProvenance: {
            evidenceReference,
            method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
            reason: `Order ${order.number} confirmed by staff`,
            source: provenanceSource,
          },
          customerEvidence: {
            evidenceReference,
            method: 'APPROVED_PURCHASING_RELATIONSHIP',
            reason: `Order ${order.number} confirmed by staff`,
            source: provenanceSource,
          },
          partyRef,
          validFrom: DateTime.formatIso(validFrom),
        },
        options('onboard'),
      )
      .pipe(
        Effect.catchIf(Schema.is(PartyCommandAlreadyCommittedProblemSchema), () =>
          owners.customers.pipe(
            Effect.flatMap((items) => {
              const customer = currentCustomer(items);
              return customer === undefined
                ? Effect.fail(
                    new OrderCustomerConversionError({
                      reason: 'Zákaznická role zatím není dostupná. Zkuste to později.',
                    }),
                  )
                : Effect.succeed(customer);
            }),
          ),
        ),
      ));
  const contactPoint = yield* Schema.decodeEffect(AddContactPointPayloadSchema)({
    contactPoint: { preferred: true, type: 'EMAIL', value: order.contact.email },
    partyRef,
    privacyClassification: 'BUSINESS_SENSITIVE',
    provenance: { authoritative: false, evidenceReference, method: 'MANUAL_CONFIRMATION', source: 'USER_ASSERTION' },
    validFrom: DateTime.formatIso(validFrom),
    verification: { state: 'UNVERIFIED' },
  });
  yield* owners
    .contact(contactPoint, options('email'))
    .pipe(Effect.catchIf(Schema.is(PartyCommandAlreadyCommittedProblemSchema), () => Effect.void));
  return { counterpartyRef: onboarded.counterpartyRef, partyRef };
});
