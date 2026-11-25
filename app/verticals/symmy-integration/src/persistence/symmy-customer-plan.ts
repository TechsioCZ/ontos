import {
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  OrganizationBusinessSourceStatement,
} from '@app/party-registry/apis/organization-record-facts';
import { Array as EffectArray, DateTime, Effect, Option, Schema } from 'effect';

import {
  SYMMY_ADDRESS_REASON,
  SYMMY_ADDRESS_SOURCE_ORDER,
  SYMMY_ADDRESS_SOURCE_REVISION,
  SYMMY_CONTACT_PROVENANCE,
  SYMMY_COUNTERPARTY_PROVENANCE_METHOD,
  SYMMY_CUSTOMER_EVIDENCE_METHOD,
  SYMMY_CUSTOMER_EVIDENCE_REF,
  SYMMY_CUSTOMER_PERSON_STATEMENT,
  SYMMY_CUSTOMER_SOURCE_REVISION_STEM,
  SYMMY_EFFECT_ASSIGNED_AT_ADMISSION,
  symmyCustomerAddressRecordSeed,
  symmyCustomerContactRecordSeed,
  symmyCustomerOccurrenceSeed,
  symmyCustomerRecordSeed,
} from '../../shared/domain/symmy-customer-batch.ts';
import type {
  SymmyCustomerAddress,
  SymmyCustomerRow,
  SymmyCustomerRows,
} from '../../shared/domain/symmy-customer-batch.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { uuidFromDigest } from './derived-identity.ts';
import { enrolledItem } from './symmy-price-list-plan.ts';
import type { Digest } from './symmy-price-list-plan.ts';

const party = 'party.registry';
const commerce = 'commerce.customer-context';
const operation = (moduleId: string, entrypointKey: string) =>
  ({ entrypointKey, moduleId, schemaVersion: '1' }) as const;
export const createPartyOperation = operation(party, 'party.registry.create-party');
export const addContactOperation = operation(party, 'party.registry.add-contact-point');
export const onboardOperation = operation(party, 'party.registry.counterparty-customer-onboard');
export const retailProfileOperation = operation(commerce, 'commerce.customer-context.ensure-retail-customer-profile');
export const counterpartyProfileOperation = operation(
  commerce,
  'commerce.customer-context.create-counterparty-purchasing-profile',
);
export const addAddressOperation = operation(commerce, 'commerce.customer-context.add-saved-address');
export const organizationIcoOperation = operation(
  commerce,
  'commerce.customer-context.change-organization-customer-profile-ico',
);

const partyKey = 'party-create';
const retailProfileKey = 'retail-profile';
const onboardKey = 'counterparty-onboard';
const counterpartyProfileKey = 'counterparty-profile';
const addressKey = 'address-add';
const contactKey = 'contact-add';
const icoKey = 'ico-set';
/** A source record id the owners accept: bounded to the Party source identifier and free of surrounding blanks. */
const MAX_SOURCE_RECORD_LENGTH = 200;

type TemplateSource = SymmyFixtureExecutionPlan['items'][number]['source'];

/** The route facts every customer shares: the source it enrolls, its authority, the selling legal entity and the instant. */
interface CustomerContext {
  /** True when the route enrolls the company ICO change for the customer source: only then an ICO can be written. */
  readonly icoEnrolled: boolean;
  readonly legalEntityRef: {
    readonly moduleId: 'core.identity';
    readonly resourceId: string;
    readonly resourceType: 'core.identity.legal-entity';
    readonly tenantId: string;
  };
  readonly mappingRevision: string;
  readonly observation: DateTime.Utc;
  readonly order: number;
  readonly revision: string;
  readonly routeId: string;
  readonly routeRevision: string;
  readonly source: TemplateSource;
}

/** The authority of the source route the owners enrolled: it is the route identity of every source assertion. */
export interface SymmyCustomerSourceAuthority {
  readonly mappingRevision: string;
  readonly routeId: string;
  readonly routeRevision: string;
}

/** A literal key that only exists when it has a value, so no absent value is ever written as undefined. */
const present = <Value>(key: string, value: Value | undefined): Readonly<Record<string, Value>> =>
  value === undefined ? {} : { [key]: value };

interface ItemFacts {
  readonly context: CustomerContext;
  readonly occurrenceId: string;
  readonly recordId: string;
}

/** The instant of the first admission in the owners' canonical form. */
const observedAt = (facts: ItemFacts): string => DateTime.formatIso(facts.context.observation);
const itemSource = (facts: ItemFacts) => ({
  entityKind: facts.context.source.entityKind,
  issuerId: facts.context.source.issuerId,
  sourceNamespace: facts.context.source.sourceNamespace,
  sourceRecordId: facts.recordId,
});

const sourceIdentity = (facts: ItemFacts) => ({
  issuer: facts.context.source.issuerId,
  namespace: facts.context.source.sourceNamespace,
  recordType: facts.context.source.entityKind,
  routeRef: facts.context.routeId,
});
const sourceReference = (facts: ItemFacts) => ({
  occurrenceId: facts.occurrenceId,
  recordId: facts.recordId,
  source: sourceIdentity(facts),
});
/** The profile source assertion: its order and revision advance with each admission, as the owner requires. */
const profileSource = (facts: ItemFacts) => ({
  effectId: SYMMY_EFFECT_ASSIGNED_AT_ADMISSION,
  issuer: facts.context.source.issuerId,
  mappingRevision: facts.context.mappingRevision,
  namespace: facts.context.source.sourceNamespace,
  occurrenceId: facts.occurrenceId,
  order: facts.context.order,
  recordId: facts.recordId,
  recordType: facts.context.source.entityKind,
  revision: facts.context.revision,
  route: { id: facts.context.routeId, revision: facts.context.routeRevision },
});
const profileSubject = (facts: ItemFacts, kind: 'COUNTERPARTY' | 'RETAIL') => ({
  kind,
  sellingLegalEntityRef: facts.context.legalEntityRef,
});

const partyCreateIntent = (facts: ItemFacts, row: SymmyCustomerRow) => {
  const identifiers = row.officialIdentifiers.filter(({ identifierType }) => identifierType !== 'ICO');
  const evidence = {
    kind: 'CLIENT_SOURCE_ASSERTION',
    observedSubject: row.kind,
    occurrenceId: facts.occurrenceId,
    recordId: facts.recordId,
    source: sourceIdentity(facts),
    sourceObservedAt: observedAt(facts),
    statement: row.kind === 'PERSON' ? SYMMY_CUSTOMER_PERSON_STATEMENT : OrganizationBusinessSourceStatement,
    subjectKey: facts.recordId,
  };
  const names =
    row.kind === 'PERSON' ? { firstName: row.firstName, lastName: row.lastName } : { businessName: row.businessName };
  return {
    _tag: 'PartyCreate',
    payload: {
      candidate: {
        ...names,
        evidenceRefs: row.kind === 'PERSON' ? [SYMMY_CUSTOMER_EVIDENCE_REF] : [],
        officialIdentifiers: identifiers,
        partyType: row.kind,
        provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: facts.context.routeId },
        subjectEvidence: [evidence],
        validFrom: observedAt(facts),
      },
    },
  };
};

/** The one ICO an organization states, or none when it states none or states two different ones. */
const organizationIco = (row: SymmyCustomerRow): Option.Option<string> => {
  const values = row.officialIdentifiers.flatMap(({ identifierType, value }) =>
    identifierType === 'ICO' ? [value] : [],
  );
  const distinct = EffectArray.dedupeWith(values, (left, right) => left.padStart(8, '0') === right.padStart(8, '0'));
  const [only] = distinct;
  return row.kind === 'ORGANIZATION' && distinct.length === 1 && only !== undefined ? Option.some(only) : Option.none();
};

/** The company ICO goes to the profile the same job creates, as the first assertion of that profile. */
const icoEffect = (facts: ItemFacts, itemKey: string, ico: string) => ({
  dependsOn: [counterpartyProfileKey],
  effectKey: icoKey,
  intent: {
    _tag: 'OrganizationCustomerProfileIcoFromProfileEffect',
    fromProfileEffect: { effectKey: counterpartyProfileKey, itemKey },
    payload: {
      countryCode: 'CZ',
      effectiveAt: observedAt(facts),
      expectedRevision: 0,
      identifier: { identifierType: 'ICO', value: ico },
      operation: 'SET',
      originalInput: ico,
    },
    sourceReference: sourceReference(facts),
  },
  operation: organizationIcoOperation,
});

const profileEffects = (facts: ItemFacts, row: SymmyCustomerRow, itemKey: string) => {
  if (row.kind === 'PERSON') {
    return [
      {
        dependsOn: [partyKey],
        effectKey: retailProfileKey,
        intent: {
          _tag: 'EnsureRetailProfileFromParty',
          fromPartyEffect: { effectKey: partyKey, itemKey },
          payload: {
            effectiveAt: observedAt(facts),
            partySourceReference: sourceReference(facts),
            source: profileSource(facts),
            subject: profileSubject(facts, 'RETAIL'),
            trigger: 'AUTHORIZED_ONBOARDING',
          },
        },
        operation: retailProfileOperation,
      },
    ];
  }
  const provenance = { evidenceReference: facts.recordId, source: facts.context.routeId };
  return [
    {
      dependsOn: [partyKey],
      effectKey: onboardKey,
      intent: {
        _tag: 'OnboardCounterpartyCustomerFromParty',
        fromPartyEffect: { effectKey: partyKey, itemKey },
        payload: {
          counterpartyProvenance: {
            ...provenance,
            method: SYMMY_COUNTERPARTY_PROVENANCE_METHOD,
            reason: OrganizationBusinessCounterpartyContextReason,
          },
          customerEvidence: {
            ...provenance,
            method: SYMMY_CUSTOMER_EVIDENCE_METHOD,
            reason: OrganizationBusinessCustomerRoleReason,
          },
          sourceReference: sourceReference(facts),
          validFrom: observedAt(facts),
        },
      },
      operation: onboardOperation,
    },
    {
      dependsOn: [onboardKey],
      effectKey: counterpartyProfileKey,
      intent: {
        _tag: 'CreateCounterpartyProfileFromCounterparty',
        fromCounterpartyEffect: { effectKey: onboardKey, itemKey },
        payload: {
          effectiveAt: observedAt(facts),
          partySourceReference: sourceReference(facts),
          source: profileSource(facts),
          subject: profileSubject(facts, 'COUNTERPARTY'),
          trigger: 'AUTHORIZED_ONBOARDING',
        },
      },
      operation: counterpartyProfileOperation,
    },
    ...(facts.context.icoEnrolled
      ? Option.match(organizationIco(row), {
          onNone: () => [],
          onSome: (ico) => [icoEffect(facts, itemKey, ico)],
        })
      : []),
  ];
};

const contactItem = (
  facts: ItemFacts,
  row: SymmyCustomerRow,
  contact: SymmyCustomerRow['contacts'][number],
  customerItemKey: string,
  itemKey: string,
) => ({
  effects: [
    {
      dependsOn: [{ effectKey: partyKey, itemKey: customerItemKey }],
      effectKey: contactKey,
      intent: {
        _tag: 'AddPartyContactPointFromParty',
        fromPartyEffect: { effectKey: partyKey, itemKey: customerItemKey },
        payload: {
          contactPoint: contact,
          privacyClassification: row.kind === 'PERSON' ? 'PERSONAL' : 'BUSINESS_SENSITIVE',
          provenance: SYMMY_CONTACT_PROVENANCE,
          sourceReference: sourceReference(facts),
          validFrom: observedAt(facts),
        },
      },
      operation: addContactOperation,
    },
  ],
  itemKey,
  source: itemSource(facts),
  sourceOccurrenceId: facts.occurrenceId,
});

const icoUnwritten = (facts: ItemFacts, row: SymmyCustomerRow) =>
  row.officialIdentifiers.some(({ identifierType }) => identifierType === 'ICO') &&
  !(facts.context.icoEnrolled && Option.isSome(organizationIco(row)));

const customerItem = (facts: ItemFacts, row: SymmyCustomerRow, itemKey: string) => ({
  effects: [
    {
      effectKey: partyKey,
      intent: partyCreateIntent(facts, row),
      operation: createPartyOperation,
    },
    ...profileEffects(facts, row, itemKey),
  ],
  itemKey,
  source: itemSource(facts),
  sourceOccurrenceId: facts.occurrenceId,
  // An ICO the item does not write is reported instead of dropped: a person's ICO, two different ICOs of one
  // organization, or an organization of a route that does not enroll the company ICO change.
  ...present(
    'unsupportedBranches',
    icoUnwritten(facts, row) ? [{ branchKey: 'identifier', kind: 'IdentifierHint' }] : undefined,
  ),
});

const addressItem = (
  facts: ItemFacts,
  row: SymmyCustomerRow,
  address: SymmyCustomerAddress,
  customerItemKey: string,
  itemKey: string,
) => {
  const payload = {
    ...present('label', address.label),
    postalAddress: address.postalAddress,
    purposes: address.purposes,
    reason: SYMMY_ADDRESS_REASON,
    source: {
      effectId: SYMMY_EFFECT_ASSIGNED_AT_ADMISSION,
      identity: { ...sourceIdentity(facts), occurrenceId: facts.occurrenceId, recordId: facts.recordId },
      mappingRevision: facts.context.mappingRevision,
      order: SYMMY_ADDRESS_SOURCE_ORDER,
      purposes: address.purposes,
      revision: SYMMY_ADDRESS_SOURCE_REVISION,
      routeRevision: facts.context.routeRevision,
    },
  };
  const profile = {
    effectKey: row.kind === 'PERSON' ? retailProfileKey : counterpartyProfileKey,
    itemKey: customerItemKey,
  };
  const counterparty = { effectKey: onboardKey, itemKey: customerItemKey };
  return {
    effects: [
      {
        dependsOn: row.kind === 'PERSON' ? [profile] : [counterparty, profile],
        effectKey: addressKey,
        intent:
          row.kind === 'PERSON'
            ? { _tag: 'AddSavedRetailAddressFromProfileEffect', fromProfileEffect: profile, payload }
            : {
                _tag: 'AddSavedCounterpartyAddressFromProfileEffect',
                fromCounterpartyEffect: counterparty,
                fromProfileEffect: profile,
                payload,
              },
        operation: addAddressOperation,
      },
    ],
    itemKey,
    source: itemSource(facts),
    sourceOccurrenceId: facts.occurrenceId,
  };
};

interface CustomerFacts<Failure> {
  readonly context: CustomerContext;
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  readonly index: number;
  readonly row: SymmyCustomerRow;
}

/** A source record id for a customer id the owners accept, or the one derived from the customer id when they do not. */
const customerRecordId = Effect.fn('SymmyCustomerPlan.recordId')(function* customerRecordId<Failure>(
  customerId: string,
  digest: Digest<Failure>,
) {
  if (customerId.length <= MAX_SOURCE_RECORD_LENGTH && customerId === customerId.trim()) {
    return customerId;
  }
  return `symmy-customer:${yield* digest(symmyCustomerRecordSeed(customerId))}`;
});

const occurrenceOf = <Failure>(digest: Digest<Failure>, idempotencyKey: string, itemKey: string) =>
  digest(symmyCustomerOccurrenceSeed(idempotencyKey, itemKey)).pipe(Effect.map(uuidFromDigest));

/** One customer item and the items of its addresses. */
const buildCustomer = Effect.fn('SymmyCustomerPlan.customer')(function* buildCustomer<Failure>(
  facts: CustomerFacts<Failure>,
) {
  const { context, digest, idempotencyKey, index, row } = facts;
  const itemKey = `customer-${index}`;
  const recordId = yield* customerRecordId(row.customerId, digest);
  const customer = customerItem(
    { context, occurrenceId: yield* occurrenceOf(digest, idempotencyKey, itemKey), recordId },
    row,
    itemKey,
  );
  const contacts = yield* Effect.forEach(
    row.contacts,
    Effect.fn('SymmyCustomerPlan.contact')(function* buildContact(contact, position) {
      const contactItemKey = `contact-${index}-${position}`;
      const record = yield* digest(symmyCustomerContactRecordSeed(recordId, contact));
      return contactItem(
        {
          context,
          occurrenceId: yield* occurrenceOf(digest, idempotencyKey, contactItemKey),
          recordId: `symmy-contact:${record}`,
        },
        row,
        contact,
        itemKey,
        contactItemKey,
      );
    }),
    { concurrency: 1 },
  );
  const addresses = yield* Effect.forEach(
    row.addresses,
    Effect.fn('SymmyCustomerPlan.address')(function* buildAddress(address, position) {
      const addressItemKey = `address-${index}-${position}`;
      const record = yield* digest(symmyCustomerAddressRecordSeed(recordId, address));
      return addressItem(
        {
          context,
          occurrenceId: yield* occurrenceOf(digest, idempotencyKey, addressItemKey),
          recordId: `symmy-address:${record}`,
        },
        row,
        address,
        itemKey,
        addressItemKey,
      );
    }),
    { concurrency: 1 },
  );
  return [customer, ...contacts, ...addresses];
});

export interface SymmyCustomerPlanInput<Failure> {
  /** The authority of the source route: the route identity, its revision and the mapping every assertion cites. */
  readonly authority: SymmyCustomerSourceAuthority;
  /** A stable hex digest. Replays of one Idempotency-Key must reproduce every derived identity. */
  readonly digest: Digest<Failure>;
  readonly idempotencyKey: string;
  /** The selling legal entity of every profile. It comes from the route scope, never from the body. */
  readonly legalEntityId: string | undefined;
  /** The instant of the first admission. A replay never reaches this builder, it reads the saved plan. */
  readonly receivedAt: DateTime.Utc;
  readonly rows: SymmyCustomerRows;
  readonly template: SymmyFixtureExecutionPlan;
  readonly tenantId: string;
}

const sameSource = (left: TemplateSource, right: TemplateSource) =>
  left.entityKind === right.entityKind &&
  left.issuerId === right.issuerId &&
  left.sourceNamespace === right.sourceNamespace;

/** The one source every customer record shares, or none when the route does not enroll the operations the rows need. */
const enrolledSource = (
  rows: SymmyCustomerRows,
  template: SymmyFixtureExecutionPlan,
): Option.Option<TemplateSource> => {
  const creation = template.items.find(({ effects }) =>
    effects.some(
      ({ operation: enrolled }) =>
        enrolled.moduleId === createPartyOperation.moduleId &&
        enrolled.entrypointKey === createPartyOperation.entrypointKey &&
        enrolled.schemaVersion === createPartyOperation.schemaVersion,
    ),
  );
  if (creation === undefined) {
    return Option.none();
  }
  const { source } = creation;
  const required = [
    ...(rows.some(({ kind }) => kind === 'PERSON') ? [retailProfileOperation] : []),
    ...(rows.some(({ kind }) => kind === 'ORGANIZATION') ? [onboardOperation, counterpartyProfileOperation] : []),
    ...(rows.some(({ contacts }) => contacts.length > 0) ? [addContactOperation] : []),
    ...(rows.some(({ addresses }) => addresses.length > 0) ? [addAddressOperation] : []),
  ];
  return required.every((needed) => {
    const item = enrolledItem(template, source.entityKind, needed);
    return Option.isSome(item) && sameSource(item.value.source, source);
  })
    ? Option.some(source)
    : Option.none();
};

/** Whether the route enrolls the company ICO change for the one source every customer record shares. */
const icoEnrolled = (template: SymmyFixtureExecutionPlan, source: TemplateSource): boolean => {
  const item = enrolledItem(template, source.entityKind, organizationIcoOperation);
  return Option.isSome(item) && sameSource(item.value.source, source);
};

/**
 * Maps the public customers to one internal plan: per customer an item with the Party create, its profile (an
 * organization also its counterparty role and its company ICO), one add per contact, and an item per address that saves the address
 * on the profile once the profile effect returned it. A route that does not enroll the owner operations, the
 * selling legal entity or the source yields no plan at all, so nothing is admitted and no owner call is made.
 */
export const buildSymmyCustomerPlan = Effect.fn('SymmyCustomerPlan.build')(function* buildSymmyCustomerPlan<Failure>(
  input: SymmyCustomerPlanInput<Failure>,
) {
  const { authority, digest, idempotencyKey, legalEntityId, receivedAt, rows, template, tenantId } = input;
  const source = enrolledSource(rows, template);
  if (Option.isNone(source) || legalEntityId === undefined) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  const revisionDigest = yield* digest(`customer-revision\u0000${idempotencyKey}`);
  const context: CustomerContext = {
    icoEnrolled: icoEnrolled(template, source.value),
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    mappingRevision: authority.mappingRevision,
    observation: receivedAt,
    order: Math.floor(DateTime.toEpochMillis(receivedAt) / 1000),
    revision: `${SYMMY_CUSTOMER_SOURCE_REVISION_STEM}-${revisionDigest}`,
    routeId: authority.routeId,
    routeRevision: authority.routeRevision,
    source: source.value,
  };
  const customers = yield* Effect.forEach(
    rows,
    (row, index) => buildCustomer({ context, digest, idempotencyKey, index, row }),
    { concurrency: 1 },
  );
  return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items: EffectArray.flatten(customers) });
});
