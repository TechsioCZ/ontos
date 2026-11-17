import { createHash } from 'node:crypto';

import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomerRowsSchema } from '../../shared/domain/symmy-customer-batch.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyPartyCommerceIntentSchema } from '../../shared/domain/symmy-party-commerce-intents.ts';
import { buildSymmyCustomerPlan } from '../../src/persistence/symmy-customer-plan.ts';
import { symmyRequestItemKey } from '../../src/persistence/symmy-job-execution-store.ts';

type PlanItem = SymmyFixtureExecutionPlan['items'][number];
type PlanEffect = PlanItem['effects'][number];

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const routeId = '33333333-3333-4333-8333-333333333333';
const authority = { mappingRevision: 'mapping-1', routeId, routeRevision: 'route-1' };
const operations = {
  address: { entrypointKey: 'commerce.customer-context.add-saved-address', moduleId: 'commerce.customer-context' },
  contact: { entrypointKey: 'party.registry.add-contact-point', moduleId: 'party.registry' },
  counterpartyProfile: {
    entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
    moduleId: 'commerce.customer-context',
  },
  create: { entrypointKey: 'party.registry.create-party', moduleId: 'party.registry' },
  ico: {
    entrypointKey: 'commerce.customer-context.change-organization-customer-profile-ico',
    moduleId: 'commerce.customer-context',
  },
  onboard: { entrypointKey: 'party.registry.counterparty-customer-onboard', moduleId: 'party.registry' },
  retail: {
    entrypointKey: 'commerce.customer-context.ensure-retail-customer-profile',
    moduleId: 'commerce.customer-context',
  },
} as const;
const templateWith = (...enrolled: readonly (typeof operations)[keyof typeof operations][]) =>
  Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: [
      {
        effects: enrolled.map((operation, index) => ({
          effectKey: `enrolled-${index}`,
          operation: { ...operation, schemaVersion: '1' },
        })),
        itemKey: 'customer',
        source: {
          entityKind: 'CUSTOMER',
          issuerId: 'route-issuer',
          sourceNamespace: 'route-namespace',
          sourceRecordId: 'enrollment',
        },
      },
    ],
    sourceRouteId: routeId,
  });
const fullTemplate = templateWith(...Object.values(operations));

const postalAddress = { addressLine1: '17 Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' };
interface RowOverrides {
  readonly addresses?: readonly unknown[];
  readonly contacts?: readonly unknown[];
  readonly customerId?: string;
  readonly officialIdentifiers?: readonly unknown[];
}
const base = { addresses: [], contacts: [], officialIdentifiers: [] };
const person = (overrides: RowOverrides = {}) => ({
  ...base,
  customerId: 'customer-1',
  firstName: 'Ada',
  kind: 'PERSON',
  lastName: 'Lovelace',
  ...overrides,
});
const organization = (overrides: RowOverrides = {}) => ({
  ...base,
  businessName: 'Acme',
  customerId: 'company-1',
  kind: 'ORGANIZATION',
  ...overrides,
});
const contactsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    preferred: index === 0,
    type: 'EMAIL',
    value: `office-${index}@example.test`,
  }));
const addressesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    postalAddress: { ...postalAddress, addressLine1: `${index} Street` },
    purposes: ['BILLING'],
  }));
const rowsOf = (...rows: readonly unknown[]) => Schema.decodeUnknownSync(SymmyCustomerRowsSchema)(rows);
const digest = (value: string) => Effect.succeed(createHash('sha256').update(value).digest('hex'));
const receivedAt = DateTime.makeUnsafe('2026-11-16T10:00:00.000Z');
/** A route without a selling legal entity. */
const noLegalEntity = Option.getOrUndefined(Option.none<string>());
interface BuildOptions {
  readonly idempotencyKey?: string;
  readonly template?: SymmyFixtureExecutionPlan;
  readonly withoutLegalEntity?: boolean;
}
const build = (rows: ReturnType<typeof rowsOf>, options: BuildOptions = {}) =>
  buildSymmyCustomerPlan({
    authority,
    digest,
    idempotencyKey: options.idempotencyKey ?? 'customer-key-1',
    legalEntityId: options.withoutLegalEntity === true ? noLegalEntity : legalEntityId,
    receivedAt,
    rows,
    template: options.template ?? fullTemplate,
    tenantId,
  });
const keysOf = (plan: SymmyFixtureExecutionPlan) =>
  plan.items.map((item) => ({ effects: item.effects.map(({ effectKey }) => effectKey), itemKey: item.itemKey }));
const tagOf = (effect: PlanEffect | undefined) => effect?.intent?._tag;
const recordOf = (item: PlanItem | undefined) => item?.source.sourceRecordId;
const occurrenceOf = (item: PlanItem) => item.sourceOccurrenceId;
const withAddresses = (count: number) => person({ addresses: addressesOf(count) });

describe('Symmy customer plan from the public rows', () => {
  it.effect('plans a person as a Party create then its retail profile, in dependency order', () =>
    Effect.gen(function* plansPerson() {
      const plan = Option.getOrThrow(yield* build(rowsOf(person())));
      expect(keysOf(plan)).toEqual([{ effects: ['party-create', 'retail-profile'], itemKey: 'customer-0' }]);
      const [item] = plan.items;
      const [create, profile] = item?.effects ?? [];
      expect(create?.dependsOn).toBeUndefined();
      expect(profile?.dependsOn).toEqual(['party-create']);
      expect(tagOf(create)).toBe('PartyCreate');
      expect(create?.intent).toMatchObject({
        payload: {
          candidate: {
            evidenceRefs: ['SYMMY_EXPLICIT_CLIENT_RECORD'],
            firstName: 'Ada',
            lastName: 'Lovelace',
            officialIdentifiers: [],
            partyType: 'PERSON',
            provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: routeId },
            subjectEvidence: [
              {
                kind: 'CLIENT_SOURCE_ASSERTION',
                observedSubject: 'PERSON',
                recordId: 'customer-1',
                source: {
                  issuer: 'route-issuer',
                  namespace: 'route-namespace',
                  recordType: 'CUSTOMER',
                  routeRef: routeId,
                },
                sourceObservedAt: '2026-11-16T10:00:00.000Z',
                subjectKey: 'customer-1',
              },
            ],
            validFrom: '2026-11-16T10:00:00.000Z',
          },
        },
      });
      expect(tagOf(profile)).toBe('EnsureRetailProfileFromParty');
      expect(profile?.intent).toMatchObject({
        fromPartyEffect: { effectKey: 'party-create', itemKey: 'customer-0' },
        payload: {
          effectiveAt: '2026-11-16T10:00:00.000Z',
          source: { mappingRevision: 'mapping-1', recordId: 'customer-1', route: { id: routeId, revision: 'route-1' } },
          subject: {
            kind: 'RETAIL',
            sellingLegalEntityRef: { moduleId: 'core.identity', resourceId: legalEntityId, tenantId },
          },
          trigger: 'AUTHORIZED_ONBOARDING',
        },
      });
      // Every effect states a typed owner intent.
      for (const { effects } of plan.items) {
        for (const { intent } of effects) {
          expect(Schema.is(SymmyPartyCommerceIntentSchema)(intent)).toBe(true);
        }
      }
    }),
  );

  it.effect('plans an organization as its Party, the counterparty role and the counterparty profile', () =>
    Effect.gen(function* plansOrganization() {
      const plan = Option.getOrThrow(yield* build(rowsOf(organization())));
      expect(keysOf(plan)).toEqual([
        { effects: ['party-create', 'counterparty-onboard', 'counterparty-profile'], itemKey: 'customer-0' },
      ]);
      const [item] = plan.items;
      const [create, onboard, profile] = item?.effects ?? [];
      expect(onboard?.dependsOn).toEqual(['party-create']);
      expect(profile?.dependsOn).toEqual(['counterparty-onboard']);
      expect(tagOf(create)).toBe('PartyCreate');
      expect(create?.intent).toMatchObject({
        payload: { candidate: { businessName: 'Acme', evidenceRefs: [], partyType: 'ORGANIZATION' } },
      });
      expect(tagOf(onboard)).toBe('OnboardCounterpartyCustomerFromParty');
      expect(onboard?.intent).toMatchObject({
        payload: { sourceReference: { recordId: 'company-1' }, validFrom: '2026-11-16T10:00:00.000Z' },
      });
      expect(tagOf(profile)).toBe('CreateCounterpartyProfileFromCounterparty');
      expect(profile?.intent).toMatchObject({
        fromCounterpartyEffect: { effectKey: 'counterparty-onboard', itemKey: 'customer-0' },
        payload: { subject: { kind: 'COUNTERPARTY' } },
      });
    }),
  );

  it.effect('adds each contact in an item of its own, after the Party effect of the customer', () =>
    Effect.gen(function* plansContacts() {
      const plan = Option.getOrThrow(
        yield* build(
          rowsOf(
            person({
              contacts: [
                { preferred: true, type: 'EMAIL', value: 'ada@example.test' },
                { countryCode: 'CZ', preferred: false, type: 'PHONE', value: '603123456' },
              ],
            }),
          ),
        ),
      );
      expect(keysOf(plan)).toEqual([
        { effects: ['party-create', 'retail-profile'], itemKey: 'customer-0' },
        { effects: ['contact-add'], itemKey: 'contact-0-0' },
        { effects: ['contact-add'], itemKey: 'contact-0-1' },
      ]);
      // The poll folds the contact items back into the customer: items[n] is request item n.
      expect(plan.items.map(({ itemKey }) => symmyRequestItemKey(itemKey))).toEqual([
        'customer-0',
        'customer-0',
        'customer-0',
      ]);
      const [customer, first, second] = plan.items;
      const [contact] = first?.effects ?? [];
      expect(contact?.dependsOn).toEqual([{ effectKey: 'party-create', itemKey: 'customer-0' }]);
      expect(tagOf(contact)).toBe('AddPartyContactPointFromParty');
      expect(contact?.intent).toMatchObject({
        fromPartyEffect: { effectKey: 'party-create', itemKey: 'customer-0' },
        payload: {
          contactPoint: { type: 'EMAIL', value: 'ada@example.test' },
          privacyClassification: 'PERSONAL',
          provenance: { authoritative: false, method: 'PROVIDER_OBSERVATION', source: 'EXTERNAL_EVIDENCE' },
          sourceReference: { recordId: recordOf(first) },
        },
      });
      // The Party binds one contact point to a source record: each contact is a record of its own.
      expect(recordOf(first)).toMatch(/^symmy-contact:[0-9a-f]{64}$/u);
      expect(recordOf(second)).toMatch(/^symmy-contact:[0-9a-f]{64}$/u);
      expect(recordOf(first)).not.toBe(recordOf(second));
      expect(recordOf(first)).not.toBe(recordOf(customer));
    }),
  );

  it.effect('classifies an organization contact as business sensitive', () =>
    Effect.gen(function* plansOrganizationContact() {
      const plan = Option.getOrThrow(yield* build(rowsOf(organization({ contacts: contactsOf(1) }))));
      expect(plan.items[1]?.effects[0]?.intent).toMatchObject({
        payload: { privacyClassification: 'BUSINESS_SENSITIVE' },
      });
    }),
  );

  it.effect('saves each address on the profile in an item of its own, after the profile effect', () =>
    Effect.gen(function* plansAddresses() {
      const plan = Option.getOrThrow(
        yield* build(
          rowsOf(
            person({
              addresses: [
                { label: 'Home', postalAddress, purposes: ['BILLING', 'DELIVERY'] },
                { postalAddress: { ...postalAddress, city: 'Brno' }, purposes: ['DELIVERY'] },
              ],
            }),
          ),
        ),
      );
      expect(keysOf(plan)).toEqual([
        { effects: ['party-create', 'retail-profile'], itemKey: 'customer-0' },
        { effects: ['address-add'], itemKey: 'address-0-0' },
        { effects: ['address-add'], itemKey: 'address-0-1' },
      ]);
      const [customer, first, second] = plan.items;
      const [address] = first?.effects ?? [];
      expect(address?.dependsOn).toEqual([{ effectKey: 'retail-profile', itemKey: 'customer-0' }]);
      expect(tagOf(address)).toBe('AddSavedRetailAddressFromProfileEffect');
      expect(address?.intent).toMatchObject({
        fromProfileEffect: { effectKey: 'retail-profile', itemKey: 'customer-0' },
        payload: {
          label: 'Home',
          postalAddress,
          purposes: ['BILLING', 'DELIVERY'],
          reason: 'Qualified Symmy source explicitly imports this postal address',
          source: {
            identity: { recordType: 'CUSTOMER', routeRef: routeId },
            mappingRevision: 'mapping-1',
            purposes: ['BILLING', 'DELIVERY'],
            routeRevision: 'route-1',
          },
        },
      });
      expect(recordOf(first)).toMatch(/^symmy-address:[0-9a-f]{64}$/u);
      expect(recordOf(second)).toMatch(/^symmy-address:[0-9a-f]{64}$/u);
      expect(recordOf(first)).not.toBe(recordOf(second));
      expect(first?.sourceOccurrenceId).not.toBe(second?.sourceOccurrenceId);
      // The saved address is its own source record: a native saved address binds one record to one address.
      expect(recordOf(first)).not.toBe(recordOf(customer));
    }),
  );

  it.effect('saves an organization address after both the counterparty role and the counterparty profile', () =>
    Effect.gen(function* plansOrganizationAddress() {
      const plan = Option.getOrThrow(yield* build(rowsOf(organization({ addresses: addressesOf(1) }))));
      const [, address] = plan.items;
      const [effect] = address?.effects ?? [];
      expect(effect?.dependsOn).toEqual([
        { effectKey: 'counterparty-onboard', itemKey: 'customer-0' },
        { effectKey: 'counterparty-profile', itemKey: 'customer-0' },
      ]);
      expect(tagOf(effect)).toBe('AddSavedCounterpartyAddressFromProfileEffect');
      expect(effect?.intent).toMatchObject({
        fromCounterpartyEffect: { effectKey: 'counterparty-onboard', itemKey: 'customer-0' },
        fromProfileEffect: { effectKey: 'counterparty-profile', itemKey: 'customer-0' },
      });
    }),
  );

  it.effect('holds the worst case of one customer inside one plan: 23 owner effects, 16 items at most', () =>
    Effect.gen(function* plansWorstCase() {
      // 3 + 5 contacts + 10 addresses = 18 effects over 16 items.
      const plan = Option.getOrThrow(
        yield* build(rowsOf(organization({ addresses: addressesOf(10), contacts: contactsOf(5) }))),
      );
      expect(plan.items).toHaveLength(16);
      expect(plan.items.flatMap((item) => item.effects)).toHaveLength(18);
      expect(plan.items[0]?.effects).toHaveLength(3);
      const decoded = Schema.decodeUnknownResult(SymmyFixtureExecutionPlanSchema);
      expect(Result.isSuccess(decoded(Schema.encodeSync(SymmyFixtureExecutionPlanSchema)(plan)))).toBe(true);
      // Ten contacts and ten addresses need 21 items: the request is refused before a plan is built.
      const decode = Schema.decodeUnknownResult(SymmyCustomerRowsSchema);
      expect(Result.isFailure(decode([organization({ addresses: addressesOf(10), contacts: contactsOf(10) })]))).toBe(
        true,
      );
      expect(Result.isSuccess(decode([organization({ addresses: addressesOf(10), contacts: contactsOf(5) })]))).toBe(
        true,
      );
      expect(Result.isFailure(decode([organization({ addresses: addressesOf(10), contacts: contactsOf(6) })]))).toBe(
        true,
      );
    }),
  );

  it.effect('writes the ICO of an organization to its profile and keeps the other identifiers on the Party', () =>
    Effect.gen(function* plansIdentifiers() {
      const plan = Option.getOrThrow(
        yield* build(
          rowsOf(
            organization({
              officialIdentifiers: [
                { identifierType: 'ICO', value: '27082440' },
                { identifierType: 'CZ_DIC', value: 'CZ27082440' },
              ],
            }),
          ),
        ),
      );
      const [item] = plan.items;
      expect(item?.unsupportedBranches).toBeUndefined();
      expect(item?.effects.map(({ effectKey }) => effectKey)).toEqual([
        'party-create',
        'counterparty-onboard',
        'counterparty-profile',
        'ico-set',
      ]);
      expect(item?.effects[0]?.intent).toMatchObject({
        payload: { candidate: { officialIdentifiers: [{ identifierType: 'CZ_DIC', value: 'CZ27082440' }] } },
      });
      const ico = item?.effects[3];
      expect(ico?.dependsOn).toEqual(['counterparty-profile']);
      expect(ico?.operation).toMatchObject(operations.ico);
      expect(tagOf(ico)).toBe('OrganizationCustomerProfileIcoFromProfileEffect');
      expect(ico?.intent).toMatchObject({
        fromProfileEffect: { effectKey: 'counterparty-profile', itemKey: 'customer-0' },
        payload: {
          countryCode: 'CZ',
          effectiveAt: '2026-11-16T10:00:00.000Z',
          expectedRevision: 0,
          identifier: { identifierType: 'ICO', value: '27082440' },
          operation: 'SET',
          originalInput: '27082440',
        },
        sourceReference: { occurrenceId: item?.sourceOccurrenceId, recordId: 'company-1' },
      });
      expect(Result.isSuccess(Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema)(ico?.intent))).toBe(true);
      const [without] = Option.getOrThrow(yield* build(rowsOf(person()))).items;
      expect(without?.unsupportedBranches).toBeUndefined();
    }),
  );

  it.effect('writes one ICO once, however many times and in whatever zero padding it is stated', () =>
    Effect.gen(function* plansOneIco() {
      const [item] = Option.getOrThrow(
        yield* build(
          rowsOf(
            organization({
              officialIdentifiers: [
                { identifierType: 'ICO', value: '19' },
                { identifierType: 'ICO', value: '00000019' },
              ],
            }),
          ),
        ),
      ).items;
      expect(item?.unsupportedBranches).toBeUndefined();
      expect(item?.effects.filter(({ effectKey }) => effectKey === 'ico-set')).toHaveLength(1);
      expect(item?.effects[3]?.intent).toMatchObject({ payload: { identifier: { value: '19' }, originalInput: '19' } });
    }),
  );

  it.effect('reports an ICO it cannot write instead of dropping it', () =>
    Effect.gen(function* reportsUnwritten() {
      const ico = [{ identifierType: 'ICO', value: '27082440' }];
      const hint = [{ branchKey: 'identifier', kind: 'IdentifierHint' }];
      // A person's ICO is not written: the Retail profile is no company profile.
      const [forPerson] = Option.getOrThrow(yield* build(rowsOf(person({ officialIdentifiers: ico })))).items;
      expect(forPerson?.unsupportedBranches).toEqual(hint);
      expect(forPerson?.effects.map(({ effectKey }) => effectKey)).toEqual(['party-create', 'retail-profile']);
      // Two different ICOs of one organization name no single company ICO.
      const [conflicting] = Option.getOrThrow(
        yield* build(
          rowsOf(
            organization({
              officialIdentifiers: [...ico, { identifierType: 'ICO', value: '00000019' }],
            }),
          ),
        ),
      ).items;
      expect(conflicting?.unsupportedBranches).toEqual(hint);
      expect(conflicting?.effects.map(({ effectKey }) => effectKey)).not.toContain('ico-set');
      // A route that does not enroll the company ICO change cannot write it.
      const { ico: _enrolled, ...others } = operations;
      const [unenrolled] = Option.getOrThrow(
        yield* build(rowsOf(organization({ officialIdentifiers: ico })), {
          template: templateWith(...Object.values(others)),
        }),
      ).items;
      expect(unenrolled?.unsupportedBranches).toEqual(hint);
      expect(unenrolled?.effects.map(({ effectKey }) => effectKey)).toEqual([
        'party-create',
        'counterparty-onboard',
        'counterparty-profile',
      ]);
    }),
  );

  it.effect('derives ids from the Idempotency-Key and the customer, so a replayed key reproduces them', () =>
    Effect.gen(function* derivesIds() {
      const rows = rowsOf(person({ addresses: addressesOf(1) }));
      const first = Option.getOrThrow(yield* build(rows));
      const again = Option.getOrThrow(yield* build(rows));
      const other = Option.getOrThrow(yield* build(rows, { idempotencyKey: 'customer-key-2' }));
      expect(again).toEqual(first);
      // A new key is a new observation of the same record: new occurrences and a new profile revision, same records.
      expect(other.items.map(occurrenceOf)).not.toEqual(first.items.map(occurrenceOf));
      expect(other.items.map(recordOf)).toEqual(first.items.map(recordOf));
      expect(JSON.stringify(other.items[0]?.effects[1])).not.toBe(JSON.stringify(first.items[0]?.effects[1]));
    }),
  );

  it.effect('derives a source record for a customer id the owners cannot take as it is', () =>
    Effect.gen(function* derivesRecord() {
      const plan = Option.getOrThrow(
        yield* build(rowsOf(person({ customerId: 'x'.repeat(250) }), person({ customerId: ' padded ' }))),
      );
      for (const item of plan.items) {
        expect(recordOf(item)).toMatch(/^symmy-customer:[0-9a-f]{64}$/u);
      }
      expect(recordOf(plan.items[0])).not.toBe(recordOf(plan.items[1]));
    }),
  );

  it.effect('yields no plan when the route does not enroll an operation the rows need', () =>
    Effect.gen(function* refusesWithoutEnrollment() {
      const personOnly = templateWith(operations.create, operations.retail);
      expect(Option.isSome(yield* build(rowsOf(person()), { template: personOnly }))).toBe(true);
      expect(Option.isNone(yield* build(rowsOf(organization()), { template: personOnly }))).toBe(true);
      expect(Option.isNone(yield* build(rowsOf(person({ addresses: addressesOf(1) })), { template: personOnly }))).toBe(
        true,
      );
      expect(Option.isNone(yield* build(rowsOf(person({ contacts: contactsOf(1) })), { template: personOnly }))).toBe(
        true,
      );
      expect(Option.isNone(yield* build(rowsOf(person()), { template: templateWith(operations.retail) }))).toBe(true);
    }),
  );

  it.effect('yields no plan without a selling legal entity: the profile cannot name one', () =>
    Effect.gen(function* refusesWithoutLegalEntity() {
      expect(Option.isNone(yield* build(rowsOf(person()), { withoutLegalEntity: true }))).toBe(true);
    }),
  );
});

describe('Symmy customer rows', () => {
  const decode = Schema.decodeUnknownResult(SymmyCustomerRowsSchema);

  it('refuses a request whose customers, contacts and addresses need more than sixteen plan items', () => {
    expect(Result.isSuccess(decode([withAddresses(10), withAddresses(4)]))).toBe(true);
    expect(Result.isFailure(decode([withAddresses(10), withAddresses(5)]))).toBe(true);
    expect(Result.isSuccess(decode(Array.from({ length: 16 }, () => person())))).toBe(true);
    expect(Result.isFailure(decode(Array.from({ length: 17 }, () => person())))).toBe(true);
  });

  it('refuses an empty request', () => {
    expect(Result.isFailure(decode([]))).toBe(true);
  });
});
