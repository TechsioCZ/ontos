// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://party.ontos.test"}
import {
  loadDatabaseIdentityConnections,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { PartyCommandConflictProblemSchema, PartyCommandUnprocessableProblemSchema } from '../../shared/command-api.ts';
import type { ContactPointProvenance, PartyContactPointViewSchema } from '../../shared/domain/contact-point.ts';
import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { makeGovernedContactFixture } from '../support/governed-contact.fixture.ts';
import { makePartyReconciliationGateway } from '../support/party-reconciliation-native.fixture.ts';
import { partyCompositionSnapshot } from './application-composition.setup.ts';

const declared = {
  authoritative: false,
  method: 'DECLARED_BY_PARTY',
  source: 'PARTY_DECLARATION',
} satisfies ContactPointProvenance;

const expectDeclaredPurpose = (point: typeof PartyContactPointViewSchema.Type) => {
  assert.isOk(point.value?.type === 'ADDRESS');
  const registered = point.value.purposes.find(({ purpose }) => purpose === 'REGISTERED');
  assert.isOk(registered);
  const recordedDeclaration = { ...declared, evidenceReferences: [] };
  expect(registered.provenance).toEqual(recordedDeclaration);
  expect(registered).not.toHaveProperty('registryContext');
  expect(point.provenance).toEqual(recordedDeclaration);
  return registered;
};

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'governed contact writes and Reads preserve an omitted registry scope through preference, correction and future End',
    () =>
      Effect.gen(function* declaredRegisteredAddress() {
        const connections = yield* loadDatabaseIdentityConnections({ envPath: '/dev/null' });
        const composition = yield* partyCompositionSnapshot;
        const native = {
          issuer: yield* makeTestPgClient(connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id].connectionString),
          partyConfiguration: connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id],
        };
        const h = yield* makeGovernedContactFixture({
          adminConnectionString: connections.admin.connectionString,
          composition,
          gateway: yield* makePartyReconciliationGateway(native, composition),
          partyConfiguration: native.partyConfiguration,
        });
        const address = { addressLine1: 'Declared street 12', city: 'Praha', countryCode: 'CZ', postalCode: '11000' };
        const registered = { preferred: false, purpose: 'REGISTERED' } as const;
        const contactPoint = { address, purposes: [registered], type: 'ADDRESS' } as const;
        for (const registryContext of [
          { jurisdiction: 'SK', registryKey: 'ARES' },
          { jurisdiction: 'CZ', registryKey: 'OTHER' },
        ]) {
          const failure = yield* Effect.flip(
            h.add(
              { ...contactPoint, purposes: [{ ...registered, registryContext }] },
              {
                authoritative: true,
                evidenceReference: 'fixture/registry-observation',
                method: 'PROVIDER_OBSERVATION',
                source: 'EXTERNAL_EVIDENCE',
              },
            ),
          );
          assert.isOk(Schema.is(PartyCommandUnprocessableProblemSchema)(failure));
          expect(failure.code).toBe('party_contact_point_invalid');
        }

        const added = yield* h.add(contactPoint);
        const addedDetail = yield* h.detail(added.contactPointRef);
        expect(expectDeclaredPurpose(addedDetail)).toMatchObject({
          current: true,
          preferred: false,
          revision: 1,
          state: 'ACTIVE',
        });

        const duplicate = yield* Effect.flip(
          h.add({ ...contactPoint, address: { ...address, addressLine1: 'Other declared street 2' } }),
        );
        assert.isOk(Schema.is(PartyCommandConflictProblemSchema)(duplicate));
        expect(duplicate.code).toBe('party_contact_point_already_exists');

        const preferred = { ...registered, preferred: true };
        const updated = yield* h.update(added, { assignment: preferred, type: 'SET_ADDRESS_PURPOSE' });
        expect(expectDeclaredPurpose(yield* h.detail(added.contactPointRef))).toMatchObject({
          current: true,
          preferred: true,
          revision: 2,
        });

        const corrected = yield* h.update(updated, {
          evidenceReferences: ['fixture/address-correction-request'],
          reason: 'The declarant corrected the street number',
          replacement: {
            contactPoint: {
              ...contactPoint,
              address: { ...address, addressLine1: 'Declared street 14' },
              purposes: [preferred],
            },
            privacyClassification: 'BUSINESS_SENSITIVE',
            provenance: declared,
            validFrom: yield* DateTime.now,
          },
          type: 'CORRECT_CONTACT_POINT',
        });
        expect(corrected.contactPointRef).not.toEqual(added.contactPointRef);
        const now = yield* DateTime.now;
        const effectiveEnd = DateTime.add(now, { days: 2 });
        yield* h.update(corrected, {
          effectiveEnd,
          reason: 'The declarant supplied a future relocation date',
          target: { purpose: 'REGISTERED' },
          type: 'END_ADDRESS_PURPOSE',
        });

        const current = yield* h.detail(corrected.contactPointRef);
        expect(current.current).toBe(true);
        assert.isOk(current.value?.type === 'ADDRESS');
        expect(current.value.address.addressLine1).toBe('Declared street 14');
        const scheduled = expectDeclaredPurpose(current);
        expect(scheduled).toMatchObject({ current: true, preferred: true, state: 'ACTIVE' });
        expect(scheduled.end?.effectiveEnd).toEqual(effectiveEnd);
        expect((yield* h.list(false)).items.map(({ contactPointRef }) => contactPointRef)).toEqual([
          corrected.contactPointRef,
        ]);

        const history = yield* h.list(true);
        expect(history.items).toHaveLength(2);
        const original = history.items.find(
          ({ contactPointRef }) => contactPointRef.resourceId === added.contactPointRef.resourceId,
        );
        assert.isOk(original?.value?.type === 'ADDRESS');
        expect(original.value.address.addressLine1).toBe('Declared street 12');
        expect(original).toMatchObject({ current: false, state: 'SUPERSEDED' });
        expect(expectDeclaredPurpose(original)).toMatchObject({
          current: false,
          state: 'SUPERSEDED',
          end: { reason: 'The declarant corrected the street number' },
        });
      }),
    120_000,
  );
});
