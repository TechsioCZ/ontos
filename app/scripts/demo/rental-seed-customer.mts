import {
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
  CreatePartyPayloadJsonSchema,
  CreatePartyResultSchema,
  DuplicateCandidateDetailRequestSchema,
  DuplicateCandidateDetailResponseSchema,
  ResolveDuplicateCandidateCreatePayloadSchema,
  ResolveDuplicateCandidateCreateResultSchema,
} from '@app/party-registry/api';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { Effect, FileSystem, Schema } from 'effect';

import { DemoSeedError, SeedLegalEntityId, SeedTenantId } from './seed-client.mts';
import type { SeedClient, SeedTarget } from './seed-client.mts';

const defaultEvidenceReference = 'demo:sales-rental-v1:customer';
const seedSource = 'demo.sales-rental-v1';
const partyAudience = 'party-registry';
export const rentalCustomerName = 'Ukázkový nájemce Siampark';
/** One synthetic tenant organization: display name plus a stable key for its evidence reference. */
export interface SeedCustomerSpec {
  readonly evidenceKey: string;
  readonly name: string;
}
const defaultCustomer: SeedCustomerSpec = { evidenceKey: 'customer', name: rentalCustomerName };
const Customer = Schema.Struct({
  counterpartyRef: Schema.toEncoded(CounterpartyRefSchema),
  displayName: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
  partyRef: Schema.toEncoded(PartyRefSchema),
  status: Schema.String,
});
const Customers = Schema.Struct({ items: Schema.Array(Customer) });
const ListRequest = Schema.Struct({ includeArchived: Schema.Boolean, limit: Schema.Int });
const PartyCheckpoint = Schema.Struct({
  legalEntityId: SeedLegalEntityId,
  partyRef: Schema.toEncoded(PartyRefSchema),
  shellUrl: Schema.String,
  tenantId: SeedTenantId,
});

export const seedCustomerList = (client: SeedClient) =>
  client
    .call(partyAudience, '/reads/customer-list', ListRequest, { includeArchived: true, limit: 500 }, Customers)
    .pipe(
      Effect.flatMap(({ items }) =>
        items.length >= 500
          ? Effect.fail(
              new DemoSeedError({
                reason: 'Customer list reached its 500-record limit; refusing an incomplete duplicate check.',
              }),
            )
          : Effect.succeed(items),
      ),
    );

export const existingSeedCustomer = (items: readonly (typeof Customer.Type)[], name: string = rentalCustomerName) =>
  Effect.gen(function* existingCustomer() {
    const matches = items.filter((item) => item.displayName === name);
    if (matches.length > 1 || (matches.length === 1 && matches[0]?.status !== 'ACTIVE')) {
      return yield* new DemoSeedError({
        reason: 'Demo customer name is duplicated or archived; review it before seeding.',
      });
    }
    return matches[0];
  });

export const ensureSeedCustomer = (
  client: SeedClient,
  target: SeedTarget,
  checkpointPath: string,
  spec: SeedCustomerSpec = defaultCustomer,
) =>
  Effect.gen(function* ensureCustomer() {
    const customerEvidenceReference =
      spec.evidenceKey === defaultCustomer.evidenceKey
        ? defaultEvidenceReference
        : `demo:siampark-rental-v2:${spec.evidenceKey}`;
    const existing = yield* existingSeedCustomer(yield* seedCustomerList(client), spec.name);
    if (existing !== undefined) {
      return existing;
    }
    const fs = yield* FileSystem.FileSystem;
    const validFrom = '2026-10-05T00:00:00.000Z';
    let partyRef: typeof PartyCheckpoint.Type.partyRef;
    if (yield* fs.exists(checkpointPath)) {
      const checkpoint = yield* fs
        .readFileString(checkpointPath)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PartyCheckpoint))));
      if (
        checkpoint.shellUrl !== target.shellUrl ||
        checkpoint.tenantId !== target.tenantId ||
        checkpoint.legalEntityId !== target.legalEntityId
      ) {
        return yield* new DemoSeedError({
          reason: 'Customer checkpoint belongs to another server, tenant or legal entity.',
        });
      }
      ({ partyRef } = checkpoint);
    } else {
      const created = yield* client.call(
        partyAudience,
        '/party-registry/actions/create-party',
        CreatePartyPayloadJsonSchema,
        {
          candidate: {
            displayName: spec.name,
            evidenceRefs: [customerEvidenceReference],
            officialIdentifiers: [],
            partyType: 'ORGANIZATION',
            provenance: { method: 'MANUAL_ENTRY', source: seedSource },
            subjectEvidence: [
              {
                basis: 'DIRECT_INTERACTION',
                evidenceRef: customerEvidenceReference,
                kind: 'ACTOR_ATTESTATION',
                observedSubject: 'ORGANIZATION',
                statement: 'Synthetic organization for an operator-requested rental demo, not a real customer.',
                subjectKey: customerEvidenceReference,
              },
            ],
            validFrom,
          },
        },
        Schema.toEncoded(CreatePartyResultSchema),
        true,
      );
      if (created.outcome === 'AMBIGUOUS') {
        const detail = yield* client.call(
          partyAudience,
          '/reads/duplicate-candidate-detail',
          Schema.toEncoded(DuplicateCandidateDetailRequestSchema),
          { caseRef: created.caseRef },
          Schema.toEncoded(DuplicateCandidateDetailResponseSchema),
        );
        if (detail.candidateParties.length !== 0 || detail.lifecycleState !== 'OPEN') {
          return yield* new DemoSeedError({
            reason: 'Demo customer needs identity review. Seeder never overrides existing identity candidates.',
          });
        }
        const resolved = yield* client.call(
          partyAudience,
          '/party-registry/actions/resolve-duplicate-candidate-create',
          Schema.toEncoded(ResolveDuplicateCandidateCreatePayloadSchema),
          {
            caseRef: created.caseRef,
            expectedRevision: detail.revision,
            reason: 'Operator-requested synthetic demo organization; the case has no candidate Party.',
          },
          Schema.toEncoded(ResolveDuplicateCandidateCreateResultSchema),
          true,
        );
        if (resolved.partyRef === null) {
          return yield* new DemoSeedError({ reason: 'Demo customer case did not resolve to a Party.' });
        }
        ({ partyRef } = resolved);
      } else {
        ({ partyRef } = created);
      }
      const checkpoint = yield* Schema.encodeEffect(Schema.fromJsonString(PartyCheckpoint))({ ...target, partyRef });
      yield* fs.writeFileString(checkpointPath, checkpoint, { flag: 'wx', mode: 0o600 });
    }
    const onboarded = yield* client.call(
      partyAudience,
      '/party-registry/actions/counterparty-customer-onboard',
      Schema.toEncoded(CounterpartyCustomerOnboardPayloadSchema),
      {
        counterpartyProvenance: {
          evidenceReference: customerEvidenceReference,
          method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
          reason: 'Synthetic rental demo',
          source: seedSource,
        },
        customerEvidence: {
          evidenceReference: customerEvidenceReference,
          method: 'APPROVED_PURCHASING_RELATIONSHIP',
          reason: 'Synthetic rental demo',
          source: seedSource,
        },
        partyRef,
        validFrom,
      },
      Schema.toEncoded(CounterpartyCustomerOnboardResultSchema),
      true,
    );
    return { counterpartyRef: onboarded.counterpartyRef, displayName: spec.name, partyRef, status: 'ACTIVE' };
  });
