import { Result, Schema, Match, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyPinnedEffectSchema } from '../../shared/domain/symmy-job-execution.ts';
import type {
  SymmyPartyCommerceIntent,
  SymmyPartyCommerceOwnerReceipt,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import {
  materializeSymmyPartyCommerceIntent,
  resolveSymmyCounterpartySavedAddressFromProfile,
  resolveSymmyRetailProfileParty,
  resolveSymmyRetailSavedAddress,
  resolveSymmyRetailSavedAddressFromProfile,
  SymmyPartyCommerceIntentSchema,
  SymmyPartyCommerceOwnerReceiptSchema,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import { symmyPartyCommerceIntentMatchesEffect } from '../../src/services/symmy-party-commerce-adapters.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const routeId = '10000000-0000-4000-8000-000000000002';
const effectId = '10000000-0000-4000-8000-000000000003';
const source = { issuer: 'internal-symmy', namespace: 'customer-fixtures', recordType: 'CUSTOMER', routeRef: routeId };
const evidence = {
  kind: 'CLIENT_SOURCE_ASSERTION',
  observedSubject: 'PERSON',
  occurrenceId: 'occurrence-1',
  recordId: 'customer-1',
  source,
  sourceObservedAt: '2026-11-07T00:00:00.000Z',
  statement: 'The internal client fixture declares this person.',
  subjectKey: '10000000-0000-4000-8000-000000000004',
};
const candidate = {
  evidenceRefs: ['internal:client-source:customer-1'],
  firstName: 'Internal',
  lastName: 'Fixture',
  officialIdentifiers: [],
  partyType: 'PERSON',
  provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: 'internal-symmy' },
  subjectEvidence: [evidence],
  validFrom: '2026-11-07T00:00:00.000Z',
};
const decodeIntent = Schema.decodeUnknownSync(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' });
const decodeEffect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema, { onExcessProperty: 'error' });
const effect = decodeEffect({
  effectKey: 'party-create',
  itemId: '10000000-0000-4000-8000-000000000005',
  ref: {
    effectId,
    mappingVersion: 'mapping-1',
    occurrence: {
      occurrenceId: evidence.occurrenceId,
      record: {
        entityKind: source.recordType,
        issuerId: source.issuer,
        route: { integrationRouteId: routeId, tenantId },
        sourceNamespace: source.namespace,
        sourceRecordId: evidence.recordId,
      },
    },
    operation: { entrypointKey: 'party.registry.create-party', moduleId: 'party.registry', schemaVersion: '1' },
    routeRevision: 'route-1',
  },
});
const match = (intent: SymmyPartyCommerceIntent) => symmyPartyCommerceIntentMatchesEffect({ effect }, intent);

describe('internal Party and Commerce normalized intents', () => {
  it('requires a truthful postal purpose instead of inventing a billing or delivery default', () => {
    const parse = Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema);
    const payload = {
      contactPoint: { address: { countryCode: 'CZ' }, purposes: [], type: 'ADDRESS' },
      partyRef: {
        moduleId: 'party.registry',
        resourceId: '10000000-0000-4000-8000-000000000091',
        resourceType: 'party.registry.party',
        tenantId,
      },
      privacyClassification: 'PERSONAL',
      provenance: {
        authoritative: false,
        evidenceReference: 'internal:address-1',
        method: 'PROVIDER_OBSERVATION',
        source: 'EXTERNAL_EVIDENCE',
      },
      sourceReference: { occurrenceId: evidence.occurrenceId, recordId: evidence.recordId, source },
      validFrom: '2026-11-07T00:00:00.000Z',
    };
    expect(Result.isFailure(parse({ _tag: 'AddPartyContactPoint', payload }))).toBe(true);
    const explicit = decodeIntent({
      _tag: 'AddPartyContactPoint',
      payload: {
        ...payload,
        contactPoint: { ...payload.contactPoint, purposes: [{ preferred: false, purpose: 'BILLING' }] },
      },
    });
    expect(symmyPartyCommerceIntentMatchesEffect({ effect }, explicit)).toBe(true);
  });

  it('requires the exact independently qualified contact source, even when native human input could omit it', () => {
    const payload = {
      contactPoint: { preferred: false, type: 'EMAIL', value: 'internal@example.test' },
      partyRef: {
        moduleId: 'party.registry',
        resourceId: '10000000-0000-4000-8000-000000000091',
        resourceType: 'party.registry.party',
        tenantId,
      },
      privacyClassification: 'PERSONAL',
      provenance: { authoritative: false, method: 'PROVIDER_OBSERVATION', source: 'EXTERNAL_EVIDENCE' },
      validFrom: '2026-11-07T00:00:00.000Z',
    };
    expect(match(decodeIntent({ _tag: 'AddPartyContactPoint', payload }))).toBe(false);
    expect(
      match(
        decodeIntent({
          _tag: 'AddPartyContactPoint',
          payload: {
            ...payload,
            sourceReference: { occurrenceId: evidence.occurrenceId, recordId: 'different-source-contact', source },
          },
        }),
      ),
    ).toBe(false);
  });

  it('materializes only the owner effect identity while preserving the original source assertion', () => {
    const intent = decodeIntent({
      _tag: 'CustomerGroupMembership',
      payload: {
        completenessProofRef: 'internal:complete-membership-observation',
        effectiveAt: '2026-11-07T00:00:00.000Z',
        groupRefs: [],
        manager: {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuer: source.issuer,
          sourceNamespace: source.namespace,
          tenantId,
        },
        operation: 'COMPLETE',
        profile: {
          profileKind: 'RETAIL',
          profileRef: {
            moduleId: 'commerce.customer-context',
            resourceId: 'retail-profile',
            resourceType: 'commerce.customer-context.retail-customer-profile',
            tenantId,
          },
        },
        reason: 'The complete source list is explicitly empty',
        route: { id: routeId, revision: 'route-1' },
        source: {
          assertionId: 'actual-original-source-occurrence',
          effectId: 'operator-placeholder',
          order: 1,
          sourceRecordId: 'customer-1',
        },
      },
    });
    const pinned = materializeSymmyPartyCommerceIntent(intent, effect.ref);
    expect(pinned).toMatchObject({
      payload: {
        groupRefs: [],
        source: { assertionId: 'actual-original-source-occurrence', effectId, sourceRecordId: 'customer-1' },
      },
    });
    expect(intent).toMatchObject({ payload: { source: { effectId: 'operator-placeholder' } } });
    // Pinning an integration effect is never permission to rewrite the actual source occurrence.
    expect(symmyPartyCommerceIntentMatchesEffect({ effect }, pinned)).toBe(false);
  });

  it('resolves a Retail Party dependency only from the acknowledged canonical parent reference', () => {
    const pending = decodeIntent({
      _tag: 'EnsureRetailProfileFromParty',
      fromPartyEffect: { effectKey: 'party-create', itemKey: 'customer-1' },
      payload: {
        effectiveAt: '2026-11-07T00:00:00.000Z',
        partySourceReference: { occurrenceId: evidence.occurrenceId, recordId: evidence.recordId, source },
        source: {
          effectId: 'operator-placeholder',
          issuer: source.issuer,
          mappingRevision: 'mapping-1',
          namespace: source.namespace,
          occurrenceId: evidence.occurrenceId,
          order: 1,
          recordId: evidence.recordId,
          recordType: source.recordType,
          revision: 'source-revision-1',
          route: { id: routeId, revision: 'route-1' },
        },
        subject: {
          kind: 'RETAIL',
          sellingLegalEntityRef: {
            moduleId: 'core.identity',
            resourceId: '10000000-0000-4000-8000-000000000090',
            resourceType: 'core.identity.legal-entity',
            tenantId,
          },
        },
        trigger: 'AUTHORIZED_ONBOARDING',
      },
    });
    const receipt = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
      _tag: 'PartyCreated',
      partyRef: {
        moduleId: 'party.registry',
        resourceId: '10000000-0000-4000-8000-000000000091',
        resourceType: 'party.registry.party',
        tenantId,
      },
    });
    const resolved = Match.value(pending).pipe(
      Match.tag('EnsureRetailProfileFromParty', (intent) =>
        Match.value(receipt).pipe(
          Match.tag('PartyCreated', (created) => resolveSymmyRetailProfileParty(intent, created)),
          Match.orElse(() => {}),
        ),
      ),
      Match.orElse(() => {}),
    );
    expect(resolved).toMatchObject({
      payload: { subject: { partyRef: { resourceId: '10000000-0000-4000-8000-000000000091' } } },
    });
    expect(resolved).toMatchObject({
      payload: { partySourceReference: { occurrenceId: evidence.occurrenceId, source } },
    });
  });

  it('accepts a completely qualified client assertion without inventing actor evidence', () => {
    expect(match(decodeIntent({ _tag: 'PartyCreate', payload: { candidate } }))).toBe(true);
  });

  it.each([
    { ...source, issuer: 'another-issuer' },
    { ...source, namespace: 'another-namespace' },
    { ...source, recordType: 'ORGANIZATION' },
    { ...source, routeRef: 'another-route' },
  ])('rejects retargeting the source identity qualifier %j', (changedSource) => {
    expect(
      match(
        decodeIntent({
          _tag: 'PartyCreate',
          payload: { candidate: { ...candidate, subjectEvidence: [{ ...evidence, source: changedSource }] } },
        }),
      ),
    ).toBe(false);
  });

  it('rejects changing the original occurrence or record after admission', () => {
    for (const changed of [
      { ...evidence, occurrenceId: 'new-occurrence' },
      { ...evidence, recordId: 'another-record' },
    ]) {
      expect(
        match(
          decodeIntent({ _tag: 'PartyCreate', payload: { candidate: { ...candidate, subjectEvidence: [changed] } } }),
        ),
      ).toBe(false);
    }
  });

  it('does not synthesize missing source evidence or accept manual evidence as an ERP assertion', () => {
    expect(
      match(decodeIntent({ _tag: 'PartyCreate', payload: { candidate: { ...candidate, subjectEvidence: [] } } })),
    ).toBe(false);
    expect(
      match(
        decodeIntent({
          _tag: 'PartyCreate',
          payload: {
            candidate: {
              ...candidate,
              subjectEvidence: [{ kind: 'MANUAL_DECLARATION', observedSubject: 'PERSON', statement: 'manual' }],
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('keeps Czech ICO writes out of the Party import path', () => {
    expect(
      match(
        decodeIntent({
          _tag: 'PartyCreate',
          payload: {
            candidate: {
              ...candidate,
              officialIdentifiers: [{ identifierType: 'ICO', value: '27074358' }],
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('requires real native group meaning rather than defaulting it from a legacy name', () => {
    const decoded = Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema)({
      _tag: 'CustomerGroupCreate',
      payload: { businessCode: 'INTERNAL', initialState: 'ACTIVE', name: 'Internal group', reason: 'import' },
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  it('rejects generic JSON payloads and unrelated native operations', () => {
    const decode = Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' });
    expect(Result.isFailure(decode({ _tag: 'PartyCreate', arbitraryTarget: 'other', payload: { candidate } }))).toBe(
      true,
    );
    expect(Result.isFailure(decode({ _tag: 'CallOwner', payload: { arbitrary: true } }))).toBe(true);
  });
});

describe('saved address dependencies and source identity', () => {
  it('requires the named profile and contact to cite the same real Party and preserves the acknowledged Contact revision', () => {
    const partyRef = {
      moduleId: 'party.registry',
      resourceId: 'party-canonical',
      resourceType: 'party.registry.party',
      tenantId,
    };
    const pending = decodeIntent({
      _tag: 'AddSavedRetailAddressFromOwnerReceipts',
      fromContactPointEffect: { effectKey: 'contact', itemKey: 'address-1' },
      fromProfileEffect: { effectKey: 'profile', itemKey: 'customer-1' },
      payload: {
        purposes: ['DELIVERY'],
        reason: 'Source explicitly declares a delivery address',
        source: {
          effectId,
          identity: { ...source, occurrenceId: evidence.occurrenceId, recordId: evidence.recordId },
          mappingRevision: 'mapping-1',
          order: 1,
          purposes: ['DELIVERY'],
          revision: 'source-1',
          routeRevision: 'route-1',
        },
      },
    });
    const profile = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
      _tag: 'RetailProfileEnsured',
      partyRef,
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'retail-native',
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      },
    });
    const contact = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
      _tag: 'PartyContactPointAdded',
      contactPointRef: {
        moduleId: 'party.registry',
        resourceId: 'contact-native',
        resourceType: 'party.registry.party-contact-point',
        tenantId,
      },
      partyRef,
      revision: 7,
    });
    const resolved = Match.value(pending).pipe(
      Match.tag('AddSavedRetailAddressFromOwnerReceipts', (intent) =>
        Match.value(profile).pipe(
          Match.tag('RetailProfileEnsured', (nativeProfile) =>
            Match.value(contact).pipe(
              Match.tag('PartyContactPointAdded', (nativeContact) =>
                resolveSymmyRetailSavedAddress(intent, nativeProfile, nativeContact),
              ),
              Match.orElse(() => Option.none()),
            ),
          ),
          Match.orElse(() => Option.none()),
        ),
      ),
      Match.orElse(() => Option.none()),
    );
    expect(Option.isSome(resolved)).toBe(true);
    expect(Option.getOrUndefined(resolved)).toMatchObject({
      payload: {
        origin: {
          contactPointRef: { resourceId: 'contact-native' },
          partyRef: { resourceId: 'party-canonical' },
          sourceRevision: 7,
        },
        profile: { profileRef: { resourceId: 'retail-native' } },
        purposes: ['DELIVERY'],
      },
    });
    const mismatched = Match.value(pending).pipe(
      Match.tag('AddSavedRetailAddressFromOwnerReceipts', (intent) =>
        Match.value(profile).pipe(
          Match.tag('RetailProfileEnsured', (nativeProfile) =>
            Match.value(contact).pipe(
              Match.tag('PartyContactPointAdded', (nativeContact) =>
                resolveSymmyRetailSavedAddress(intent, nativeProfile, {
                  ...nativeContact,
                  partyRef: { ...nativeContact.partyRef, resourceId: 'another-party' },
                }),
              ),
              Match.orElse(() => Option.none()),
            ),
          ),
          Match.orElse(() => Option.none()),
        ),
      ),
      Match.orElse(() => Option.none()),
    );
    expect(Option.isNone(mismatched)).toBe(true);
  });
});

const addressRef = (moduleId: string, resourceType: string, resourceId: string, tenant = tenantId) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId: tenant,
});
const profileAddressPostal = { addressLine1: '17 Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' };
const profileAddressPayload = {
  label: 'Head office',
  postalAddress: profileAddressPostal,
  purposes: ['BILLING'],
  reason: 'Source explicitly declares a billing address',
  source: {
    effectId: 'operator-placeholder',
    identity: { ...source, occurrenceId: evidence.occurrenceId, recordId: evidence.recordId },
    mappingRevision: 'mapping-1',
    order: 1,
    purposes: ['BILLING'],
    revision: 'source-1',
    routeRevision: 'route-1',
  },
};
const profilePartyRef = addressRef('party.registry', 'party.registry.party', '10000000-0000-4000-8000-000000000091');
const profileCounterpartyRef = addressRef(
  'party.registry',
  'party.registry.counterparty',
  '10000000-0000-4000-8000-000000000092',
);
const retailProfileRef = addressRef(
  'commerce.customer-context',
  'commerce.customer-context.retail-customer-profile',
  '10000000-0000-4000-8000-000000000093',
);
const counterpartyProfileRef = addressRef(
  'commerce.customer-context',
  'commerce.customer-context.counterparty-purchasing-profile',
  '10000000-0000-4000-8000-000000000094',
);
const decodeReceipt = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema);
const retailPending = decodeIntent({
  _tag: 'AddSavedRetailAddressFromProfileEffect',
  fromProfileEffect: { effectKey: 'retail-profile', itemKey: 'customer-0' },
  payload: profileAddressPayload,
});
const counterpartyPending = decodeIntent({
  _tag: 'AddSavedCounterpartyAddressFromProfileEffect',
  fromCounterpartyEffect: { effectKey: 'counterparty-onboard', itemKey: 'customer-0' },
  fromProfileEffect: { effectKey: 'counterparty-profile', itemKey: 'customer-0' },
  payload: profileAddressPayload,
});
const retailReceipt = (tenant = tenantId) =>
  decodeReceipt({
    _tag: 'RetailProfileEnsured',
    partyRef: profilePartyRef,
    profileRef: { ...retailProfileRef, tenantId: tenant },
  });
const counterpartyReceipts = (profileTenant = tenantId) => ({
  counterparty: decodeReceipt({
    _tag: 'CounterpartyCustomerOnboarded',
    counterpartyRef: profileCounterpartyRef,
    partyRef: profilePartyRef,
  }),
  profile: decodeReceipt({
    _tag: 'CounterpartyProfileCreated',
    counterpartyRef: { ...profileCounterpartyRef, tenantId: profileTenant },
    profileRef: counterpartyProfileRef,
  }),
});
const resolveRetail = (intent: SymmyPartyCommerceIntent, profile: SymmyPartyCommerceOwnerReceipt) =>
  Match.value(intent).pipe(
    Match.tag('AddSavedRetailAddressFromProfileEffect', (pending) =>
      Match.value(profile).pipe(
        Match.tag('RetailProfileEnsured', (ensured) => resolveSymmyRetailSavedAddressFromProfile(pending, ensured)),
        Match.orElse(() => Option.none()),
      ),
    ),
    Match.orElse(() => Option.none()),
  );
const resolveCounterparty = (
  intent: SymmyPartyCommerceIntent,
  receipts: { readonly counterparty: SymmyPartyCommerceOwnerReceipt; readonly profile: SymmyPartyCommerceOwnerReceipt },
) =>
  Match.value(intent).pipe(
    Match.tag('AddSavedCounterpartyAddressFromProfileEffect', (pending) =>
      Match.value(receipts.profile).pipe(
        Match.tag('CounterpartyProfileCreated', (created) =>
          Match.value(receipts.counterparty).pipe(
            Match.tag('CounterpartyCustomerOnboarded', (onboarded) =>
              resolveSymmyCounterpartySavedAddressFromProfile(pending, created, onboarded),
            ),
            Match.orElse(() => Option.none()),
          ),
        ),
        Match.orElse(() => Option.none()),
      ),
    ),
    Match.orElse(() => Option.none()),
  );
const tagOfResolved = (resolved: Option.Option<SymmyPartyCommerceIntent>) =>
  Option.match(resolved, { onNone: () => 'none', onSome: (intent) => intent._tag });
const payloadOfResolved = (resolved: Option.Option<SymmyPartyCommerceIntent>) =>
  Option.match(resolved, { onNone: () => 'none', onSome: (intent) => intent.payload });

describe('Commerce-only saved address from a profile effect', () => {
  it('decodes only a payload that names its postal address and keeps unknown properties out', () => {
    const decode = Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' });
    const { postalAddress: _omitted, ...withoutAddress } = profileAddressPayload;
    expect(
      Result.isFailure(
        decode({
          _tag: 'AddSavedRetailAddressFromProfileEffect',
          fromProfileEffect: { effectKey: 'retail-profile', itemKey: 'customer-0' },
          payload: withoutAddress,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode({
          _tag: 'AddSavedRetailAddressFromProfileEffect',
          fromContactPointEffect: { effectKey: 'contact', itemKey: 'customer-0' },
          fromProfileEffect: { effectKey: 'retail-profile', itemKey: 'customer-0' },
          payload: profileAddressPayload,
        }),
      ),
    ).toBe(true);
  });

  it('materializes only the owner effect identity of the saved address source', () => {
    for (const pending of [retailPending, counterpartyPending]) {
      const pinned = materializeSymmyPartyCommerceIntent(pending, effect.ref);
      expect(pinned).toMatchObject({
        payload: { postalAddress: profileAddressPostal, source: { effectId, mappingRevision: 'mapping-1' } },
      });
    }
  });

  it('resolves a Retail address to a Commerce-only AddSavedAddress on the profile the parent returned', () => {
    const resolved = resolveRetail(retailPending, retailReceipt());
    expect(tagOfResolved(resolved)).toBe('AddSavedAddress');
    expect(payloadOfResolved(resolved)).toEqual({
      label: 'Head office',
      origin: { kind: 'COMMERCE_ONLY', postalAddress: profileAddressPostal },
      profile: { kind: 'RETAIL', profileRef: retailProfileRef },
      purposes: ['BILLING'],
      reason: 'Source explicitly declares a billing address',
      source: profileAddressPayload.source,
    });
    // The resolved command is the plain owner command: no field of the dependent intent leaks into it.
    expect(JSON.stringify(resolved)).not.toContain('fromProfileEffect');
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(
          Option.getOrThrow(resolved),
        ),
      ),
    ).toBe(true);
  });

  it('resolves a Counterparty address to the counterparty and profile of one onboarding', () => {
    const resolved = resolveCounterparty(counterpartyPending, counterpartyReceipts());
    expect(tagOfResolved(resolved)).toBe('AddSavedAddress');
    expect(payloadOfResolved(resolved)).toMatchObject({
      origin: { kind: 'COMMERCE_ONLY', postalAddress: profileAddressPostal },
      profile: { counterpartyRef: profileCounterpartyRef, kind: 'COUNTERPARTY', profileRef: counterpartyProfileRef },
    });
  });

  it('refuses a profile or counterparty of another Tenant or another onboarding', () => {
    const otherTenant = '10000000-0000-4000-8000-0000000000ff';
    expect(Option.isNone(resolveRetail(retailPending, retailReceipt(otherTenant)))).toBe(true);
    expect(Option.isNone(resolveCounterparty(counterpartyPending, counterpartyReceipts(otherTenant)))).toBe(true);
    const { counterparty, profile } = counterpartyReceipts();
    const other = decodeReceipt({
      _tag: 'CounterpartyCustomerOnboarded',
      counterpartyRef: { ...profileCounterpartyRef, resourceId: '10000000-0000-4000-8000-0000000000fe' },
      partyRef: profilePartyRef,
    });
    expect(Option.isNone(resolveCounterparty(counterpartyPending, { counterparty: other, profile }))).toBe(true);
    expect(Option.isSome(resolveCounterparty(counterpartyPending, { counterparty, profile }))).toBe(true);
  });

  it('never matches an effect directly: the owner command exists only after its parents settled', () => {
    expect(match(retailPending)).toBe(false);
    expect(match(counterpartyPending)).toBe(false);
  });
});

describe('explicit organization ICO contract', () => {
  const profileRef = {
    moduleId: 'commerce.customer-context',
    resourceId: '10000000-0000-4000-8000-000000000071',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  };
  const payload = {
    countryCode: 'CZ',
    effectId,
    effectiveAt: '2026-11-07T00:00:00.000Z',
    expectedRevision: 0,
    identifier: { identifierType: 'ICO', value: '27074358' },
    operation: 'SET',
    originalInput: '27074358',
    profileRef,
  };
  const input = {
    _tag: 'OrganizationCustomerProfileIco',
    payload,
    sourceReference: { occurrenceId: 'occurrence-1', recordId: 'customer-1', source },
  };
  it('requires an explicit numeric contextual contract and qualified source rather than company inference', () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(input),
      ),
    ).toBe(true);
    for (const invalid of [
      { ...input, payload: { ...payload, originalInput: 'organization name' } },
      { ...input, payload: { ...payload, reason: 'unbounded source narrative' } },
      { _tag: 'OrganizationCustomerProfileIco', payload },
      {
        ...input,
        payload: {
          ...payload,
          profileRef: { ...profileRef, resourceType: 'commerce.customer-context.retail-customer-profile' },
        },
      },
    ]) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SymmyPartyCommerceIntentSchema, { onExcessProperty: 'error' })(invalid),
        ),
      ).toBe(true);
    }
  });
  it('pins only its owner effect identity and requires exact original owner target and source occurrence', () => {
    const intent = decodeIntent(input);
    const native = decodeEffect({
      ...effect,
      ref: {
        ...effect.ref,
        operation: {
          entrypointKey: 'commerce.customer-context.change-organization-customer-profile-ico',
          moduleId: 'commerce.customer-context',
          schemaVersion: '1',
        },
        originalTarget: profileRef,
      },
    });
    expect(symmyPartyCommerceIntentMatchesEffect({ effect: native }, intent)).toBe(true);
    expect(
      symmyPartyCommerceIntentMatchesEffect(
        {
          effect: decodeEffect({
            ...native,
            ref: {
              ...native.ref,
              originalTarget: { ...profileRef, resourceType: 'commerce.customer-context.retail-customer-profile' },
            },
          }),
        },
        intent,
      ),
    ).toBe(false);
    const id = '10000000-0000-4000-8000-000000000072';
    const { ref } = decodeEffect({ ...native, ref: { ...native.ref, effectId: id } });
    expect(materializeSymmyPartyCommerceIntent(intent, ref)).toMatchObject({
      payload: { ...payload, effectId: id },
      sourceReference: input.sourceReference,
    });
  });
});
