/**
 * Demo-friendly customer facade over the governed party-registry operations.
 *
 * - `listCustomers` reads the tenant- and Legal-Entity-scoped `customer-list` read.
 * - `createCustomer` composes the existing Actions (no single Action creates a Party and its
 *   CUSTOMER context): `create-party` -> `counterparty-customer-onboard` -> `add-contact-point` (each
 *   supplied channel). A current customer with the same IČO is reused instead. A Candidate without a
 *   strong identifier comes back AMBIGUOUS; when its Duplicate Candidate Case lists no candidate Party,
 *   the explicit create request resolves it through `resolve-duplicate-candidate-create`.
 * - `updateCustomer` renames the canonical Party through `update-party` with optimistic revision.
 */
import { DateTime, Effect, Option, Random, Schema } from 'effect';

import type { CustomerListItem, CustomerListRequest } from '../../shared/apis/customer-list.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import type { DuplicateCandidateCaseRefSchema } from '../../shared/resources/duplicate-candidate-case.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import { decideAmbiguousCustomerCreate, existingCustomerWithCompanyId } from './customer-create-decision.ts';
import { executeCustomerList } from './customer-list-client.ts';
import { executeDuplicateCandidateDetail } from './duplicate-candidate-detail-client.ts';
import {
  addContactPoint,
  archiveParty,
  counterpartyCustomerOnboard,
  createParty,
  resolveDuplicateCandidateCreate,
  updateParty,
} from './party-command-client.ts';

export type { CustomerListItem, CustomerListRequest } from '../../shared/apis/customer-list.ts';

const CUSTOMER_PROVENANCE_SOURCE = 'party-registry.customers';

const requestId = (operation: string) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `party-registry:${operation}:${first}:${second}`),
  );

/** Current CUSTOMER Counterparties of the selected Legal Entity, oldest first. */
export const listCustomers = (request: CustomerListRequest = {}) =>
  requestId('customer-list').pipe(
    Effect.flatMap((id) => executeCustomerList(request, id)),
    Effect.map(({ items }) => items),
  );

export interface CreateCustomerAddress {
  readonly city?: string;
  readonly countryCode?: string;
  readonly postalCode?: string;
  readonly street?: string;
}

export interface CreateCustomerInput {
  readonly address?: CreateCustomerAddress;
  /** IČO; validated by the owner (8 digits, checksum). */
  readonly companyId?: string;
  readonly displayName: string;
  readonly email?: string;
  /** Free-text reference to what proves the customer relationship (order, contract, CRM record). */
  readonly evidenceReference?: string;
  /** Defaults to ORGANIZATION; a PERSON customer carries no IČO/DIČ. */
  readonly partyType?: 'ORGANIZATION' | 'PERSON';
  readonly phone?: string;
  /** DIČ, e.g. `CZ12345678`. */
  readonly vatId?: string;
}

export class CustomerCreateAmbiguous extends Schema.TaggedError<CustomerCreateAmbiguous>()('CustomerCreateAmbiguous', {
  caseId: Schema.String,
  reason: Schema.String,
}) {}

/**
 * `CREATED`: a new Party became a customer. `LINKED_EXISTING_PARTY`: the owner matched an existing Party and
 * onboarded it as a customer. `EXISTING_CUSTOMER`: a current customer already carries the IČO, so nothing was written.
 */
export const CreatedCustomerOutcomeSchema = Schema.Literals(['CREATED', 'LINKED_EXISTING_PARTY', 'EXISTING_CUSTOMER']);
export type CreatedCustomerOutcome = typeof CreatedCustomerOutcomeSchema.Type;

export interface CreatedCustomer {
  readonly counterpartyRef: CustomerListItem['counterpartyRef'];
  /** Name of the customer the request ended at; for `EXISTING_CUSTOMER` the name already on record. */
  readonly displayName: string | null;
  readonly outcome: CreatedCustomerOutcome;
  readonly partyRef: PartyRef;
}

const nonEmpty = (value: string | undefined): Option.Option<string> =>
  Option.fromNullishOr(value?.trim()).pipe(Option.filter((trimmed) => trimmed.length > 0));

const officialIdentifiers = (input: CreateCustomerInput) => [
  ...Option.toArray(
    Option.map(nonEmpty(input.companyId), (value) => ({
      identifierType: 'ICO' as const,
      value,
      verification: 'UNVERIFIED' as const,
    })),
  ),
  ...Option.toArray(
    Option.map(nonEmpty(input.vatId), (value) => ({
      identifierType: 'CZ_DIC' as const,
      value: value.toUpperCase(),
      verification: 'UNVERIFIED' as const,
    })),
  ),
];

interface CustomerAddressValue {
  addressLine1?: string;
  city?: string;
  countryCode: string;
  postalCode?: string;
}

const addressInputs = (address: CreateCustomerAddress | undefined) => {
  const street = nonEmpty(address?.street);
  const city = nonEmpty(address?.city);
  const postalCode = nonEmpty(address?.postalCode);
  if ([street, city, postalCode].filter(Option.isSome).length < 2) {
    return [];
  }
  const value: CustomerAddressValue = {
    countryCode: Option.getOrElse(nonEmpty(address?.countryCode), () => 'CZ').toUpperCase(),
  };
  if (Option.isSome(street)) {
    value.addressLine1 = street.value;
  }
  if (Option.isSome(city)) {
    value.city = city.value;
  }
  if (Option.isSome(postalCode)) {
    value.postalCode = postalCode.value;
  }
  return [
    {
      address: value,
      purposes: [{ preferred: true, purpose: 'CORRESPONDENCE' as const }],
      type: 'ADDRESS' as const,
    },
  ];
};

const phoneInput = (phone: string) =>
  phone.startsWith('+')
    ? { preferred: true, type: 'PHONE' as const, value: phone }
    : { countryCode: 'CZ', preferred: true, type: 'PHONE' as const, value: phone };

const contactPointInputs = (input: CreateCustomerInput) => [
  ...Option.toArray(Option.map(nonEmpty(input.email), (value) => ({ preferred: true, type: 'EMAIL' as const, value }))),
  ...Option.toArray(Option.map(nonEmpty(input.phone), phoneInput)),
  ...addressInputs(input.address),
];

/**
 * Resolves the Duplicate Candidate Case of an explicit customer create as CREATE_NEW when it lists no
 * candidate Party. Any candidate (same exact name or IČO) stays open for an Identity Reviewer.
 */
const createNewForAmbiguousCase = Effect.fn('CustomersClient.createNewForAmbiguousCase')(function* resolveCase(
  caseRef: typeof DuplicateCandidateCaseRefSchema.Type,
  id: string,
) {
  const detail = yield* executeDuplicateCandidateDetail({ caseRef }, yield* requestId('customer-case'));
  if (decideAmbiguousCustomerCreate(detail) === 'NEEDS_REVIEW') {
    return yield* new CustomerCreateAmbiguous({
      caseId: caseRef.resourceId,
      reason: 'The customer matches several existing Parties; resolve the duplicate case first',
    });
  }
  const resolved = yield* resolveDuplicateCandidateCreate(
    {
      caseRef,
      expectedRevision: detail.revision,
      reason: 'Customer explicitly created from the customer list; the case lists no candidate Party',
    },
    { correlationId: id, idempotencyKey: `${id}:resolve-create` },
  );
  if (resolved.partyRef === null) {
    return yield* new CustomerCreateAmbiguous({
      caseId: caseRef.resourceId,
      reason: 'The duplicate case did not create a Party',
    });
  }
  return resolved.partyRef;
});

/**
 * Creates (or matches) an ORGANIZATION Party, onboards it as a CUSTOMER of the selected Legal Entity,
 * then records the supplied e-mail, phone and address. Steps run sequentially; a failure after the
 * Party exists surfaces the owner's typed error so the caller can retry the remaining step.
 */
export const createCustomer = Effect.fn('CustomersClient.createCustomer')(function* createCustomerEffect(
  input: CreateCustomerInput,
) {
  const id = yield* requestId('customer-create');
  const now = yield* DateTime.now;
  const evidenceReference = Option.getOrElse(nonEmpty(input.evidenceReference), () => `customer-form:${id}`);
  const displayName = input.displayName.trim();
  const partyType = input.partyType ?? 'ORGANIZATION';
  const person = partyType === 'PERSON';
  const existing = person
    ? Option.none<CustomerListItem>()
    : existingCustomerWithCompanyId(yield* listCustomers(), input.companyId);
  if (Option.isSome(existing)) {
    return {
      counterpartyRef: existing.value.counterpartyRef,
      displayName: existing.value.displayName,
      outcome: 'EXISTING_CUSTOMER',
      partyRef: existing.value.partyRef,
    } satisfies CreatedCustomer;
  }
  const created = yield* createParty(
    {
      candidate: {
        displayName,
        evidenceRefs: [evidenceReference],
        officialIdentifiers: person ? [] : officialIdentifiers(input),
        partyType,
        provenance: { method: 'MANUAL_ENTRY', source: CUSTOMER_PROVENANCE_SOURCE },
        subjectEvidence: [
          {
            basis: 'DIRECT_INTERACTION',
            evidenceRef: evidenceReference,
            kind: 'ACTOR_ATTESTATION',
            observedSubject: partyType,
            statement: `Customer ${person ? 'person' : 'organization'} ${displayName} entered by an authorized user`,
            subjectKey: partySubjectKeyFromString(
              person
                ? Option.getOrElse(nonEmpty(input.email), () => displayName)
                : Option.getOrElse(nonEmpty(input.companyId), () => displayName),
            ),
          },
        ],
        validFrom: now,
      },
    },
    { correlationId: id, idempotencyKey: `${id}:party` },
  );
  const partyRef: PartyRef =
    created.outcome === 'AMBIGUOUS' ? yield* createNewForAmbiguousCase(created.caseRef, id) : created.partyRef;
  const onboarded = yield* counterpartyCustomerOnboard(
    {
      counterpartyProvenance: {
        evidenceReference,
        method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
        reason: 'Customer created from the customer list',
        source: CUSTOMER_PROVENANCE_SOURCE,
      },
      customerEvidence: {
        evidenceReference,
        method: 'APPROVED_PURCHASING_RELATIONSHIP',
        reason: 'Customer created from the customer list',
        source: CUSTOMER_PROVENANCE_SOURCE,
      },
      partyRef,
      validFrom: DateTime.formatIso(now),
    },
    { correlationId: id, idempotencyKey: `${id}:onboard` },
  );
  yield* Effect.forEach(
    contactPointInputs(input),
    (contactPoint, index) =>
      addContactPoint(
        {
          contactPoint,
          partyRef,
          privacyClassification: 'BUSINESS_SENSITIVE',
          provenance: {
            authoritative: false,
            evidenceReference,
            method: 'MANUAL_CONFIRMATION',
            source: 'USER_ASSERTION',
          },
          validFrom: now,
          verification: { state: 'UNVERIFIED' },
        },
        { correlationId: id, idempotencyKey: `${id}:contact:${index}` },
      ),
    { concurrency: 1, discard: true },
  );
  return {
    counterpartyRef: onboarded.counterpartyRef,
    displayName,
    outcome: created.outcome === 'MATCHED_EXISTING' ? 'LINKED_EXISTING_PARTY' : 'CREATED',
    partyRef,
  } satisfies CreatedCustomer;
});

export interface UpdateCustomerPatch {
  readonly displayName: string;
}

/**
 * Renames the customer's canonical Party. `update-party` supports only display name and Party Type
 * enrichment; contact channels change through the contact-point Actions.
 */
export const updateCustomer = Effect.fn('CustomersClient.updateCustomer')(function* updateCustomerEffect(
  customer: Pick<CustomerListItem, 'partyRef' | 'partyRevision'>,
  patch: UpdateCustomerPatch,
) {
  const id = yield* requestId('customer-update');
  const now = yield* DateTime.now;
  return yield* updateParty(
    {
      displayName: patch.displayName.trim(),
      expectedRevision: customer.partyRevision,
      partyRef: customer.partyRef,
      provenanceMethod: 'MANUAL_ENTRY',
      provenanceSource: CUSTOMER_PROVENANCE_SOURCE,
      validFrom: now,
    },
    { correlationId: id, idempotencyKey: `${id}:update` },
  );
});

/** Archives the customer's canonical Party through `archive-party` with optimistic revision. */
export const archiveCustomer = Effect.fn('CustomersClient.archiveCustomer')(function* archiveCustomerEffect(
  customer: Pick<CustomerListItem, 'partyRef' | 'partyRevision'>,
  reason: string,
) {
  const id = yield* requestId('customer-archive');
  return yield* archiveParty(
    { expectedRevision: customer.partyRevision, partyRef: customer.partyRef, reason },
    { correlationId: id, idempotencyKey: `${id}:archive` },
  );
});
