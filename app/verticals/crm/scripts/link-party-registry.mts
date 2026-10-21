#!/usr/bin/env node
/**
 * Links every active CRM client of one company to its canonical identity in Party Registry (CRM.md §3/§4, ADR-0015).
 * LOCAL demo helper, idempotent; runs through the public governed APIs as a company administrator, exactly like a
 * správce clicking "Propojit s Party Registry" on each client card:
 *
 *   1. reads the CRM records and the registry customer list;
 *   2. for a client without PartyRef reuses a current registry CUSTOMER with the same IČO (or, without IČO, the
 *      same exact name), otherwise creates the ORGANIZATION Party (IČO/DIČ unverified), resolves a no-candidate
 *      duplicate case as CREATE_NEW, onboards it as CUSTOMER and records its e-mail / phone / address as Contact
 *      Points. A duplicate case WITH candidate parties is left for an identity reviewer (reported, not linked);
 *   3. stores the link with the CRM `LinkClientParty` command, which re-reads the Counterparty on the server.
 *
 *   cd app/verticals/crm && node scripts/link-party-registry.mts            # read-only plan
 *   cd app/verticals/crm && node scripts/link-party-registry.mts --apply    # write
 *
 * Environment (defaults = local Hanák demo): ONTOS_DEMO_SEED_URL (http://localhost:3020), ONTOS_DEMO_SEED_TENANT_ID,
 * ONTOS_DEMO_SEED_LEGAL_ENTITY_ID, ONTOS_DEMO_SEED_EMAIL (spravce@hanak.demo), ONTOS_DEMO_SEED_PASSWORD.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
  CreatePartyPayloadJsonSchema,
  CreatePartyResultSchema,
  DuplicateCandidateDetailRequestSchema,
  DuplicateCandidateDetailResponseSchema,
  AddContactPointPayloadSchema,
  AddContactPointResultSchema,
  ResolveDuplicateCandidateCreatePayloadSchema,
  ResolveDuplicateCandidateCreateResultSchema,
} from '@app/party-registry/api';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import { connectSeedClient, DemoSeedError } from '../../../scripts/demo/seed-client.mts';
import type { SeedClient } from '../../../scripts/demo/seed-client.mts';

const partyAudience = 'party-registry';
const crmAudience = 'crm';
const source = 'demo.crm.party-link-v1';

const CrmClient = Schema.Struct({
  address: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  id: Schema.String,
  kind: Schema.Literals(['organization', 'person']),
  name: Schema.String,
  partyRef: Schema.optionalKey(Schema.Struct({ counterpartyId: Schema.optionalKey(Schema.String) })),
  phone: Schema.optionalKey(Schema.String),
  regNo: Schema.optionalKey(Schema.String),
  status: Schema.String,
  vatNo: Schema.optionalKey(Schema.String),
});
type CrmClient = typeof CrmClient.Type;
const CrmRecords = Schema.Struct({
  revision: Schema.Int,
  state: Schema.Struct({ clients: Schema.Struct({ items: Schema.Array(CrmClient) }) }),
});
const Empty = Schema.Struct({});
const Customer = Schema.Struct({
  companyId: Schema.NullOr(Schema.String),
  counterpartyId: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  partyId: Schema.String,
  status: Schema.String,
});
type Customer = typeof Customer.Type;
const Customers = Schema.Struct({ items: Schema.Array(Customer) });
const ListRequest = Schema.Struct({ includeArchived: Schema.Boolean, limit: Schema.Int });
const PartyLink = Schema.Struct({ counterpartyId: Schema.String, partyId: Schema.String });
const LinkCommand = Schema.Struct({
  _tag: Schema.Literal('LinkClientParty'),
  clientId: Schema.String,
  partyRef: PartyLink,
});

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('cs')
    .trim();

/** Czech IČO checksum (the registry rejects an invalid one). */
export const validIco = (value: string | undefined): value is string => {
  if (value === undefined || !/^\d{8}$/u.test(value)) {
    return false;
  }
  const digits = [...value].map(Number);
  const sum = digits.slice(0, 7).reduce((total, digit, index) => total + digit * (8 - index), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === digits[7];
};

export const addressContactPoint = (address: string | undefined) => {
  if (address === undefined) {
    return undefined;
  }
  const parts = address.split(',').map((part) => part.trim());
  const last = parts.at(-1) ?? '';
  const zip = /^(\d{3}\s?\d{2})\s+(.+)$/u.exec(last);
  if (zip === null || parts.length < 2) {
    return undefined;
  }
  return {
    address: {
      addressLine1: parts.slice(0, -1).join(', '),
      city: zip[2] ?? '',
      countryCode: 'CZ',
      postalCode: zip[1] ?? '',
    },
    purposes: [{ preferred: true, purpose: 'CORRESPONDENCE' as const }],
    type: 'ADDRESS' as const,
  };
};

/** The registry customer this client already is: same IČO, or (no IČO) the same exact name. */
export const matchingCustomer = (client: CrmClient, customers: readonly Customer[]) =>
  customers.find(
    (customer) =>
      customer.status === 'ACTIVE' &&
      (client.regNo === undefined
        ? customer.displayName !== null && fold(customer.displayName) === fold(client.name)
        : customer.companyId === client.regNo),
  );

const createCustomer = (
  client: SeedClient & { readonly target: { readonly tenantId: string } },
  crmClient: CrmClient,
  now: string,
) =>
  Effect.gen(function* createCustomerInRegistry() {
    const evidenceReference = `demo:crm-party-link:${crmClient.id}`.slice(0, 200);
    const organization = crmClient.kind === 'organization';
    const created = yield* client.call(
      partyAudience,
      '/party-registry/actions/create-party',
      CreatePartyPayloadJsonSchema,
      {
        candidate: {
          displayName: crmClient.name,
          evidenceRefs: [evidenceReference],
          officialIdentifiers: [
            ...(organization && validIco(crmClient.regNo)
              ? [{ identifierType: 'ICO' as const, value: crmClient.regNo, verification: 'UNVERIFIED' as const }]
              : []),
            ...(organization && crmClient.vatNo !== undefined && /^CZ\d{8,10}$/u.test(crmClient.vatNo)
              ? [{ identifierType: 'CZ_DIC' as const, value: crmClient.vatNo, verification: 'UNVERIFIED' as const }]
              : []),
          ],
          partyType: organization ? 'ORGANIZATION' : 'PERSON',
          provenance: { method: 'MANUAL_ENTRY', source },
          subjectEvidence: [
            {
              basis: 'DIRECT_INTERACTION',
              evidenceRef: evidenceReference,
              kind: 'ACTOR_ATTESTATION',
              observedSubject: organization ? 'ORGANIZATION' : 'PERSON',
              statement: `Demo CRM client ${crmClient.name} entered by the company administrator`,
              subjectKey: evidenceReference,
            },
          ],
          validFrom: now,
        },
      },
      Schema.toEncoded(CreatePartyResultSchema),
      true,
    );
    let partyId: string;
    if (created.outcome === 'AMBIGUOUS') {
      const detail = yield* client.call(
        partyAudience,
        '/reads/duplicate-candidate-detail',
        Schema.toEncoded(DuplicateCandidateDetailRequestSchema),
        { caseRef: created.caseRef },
        Schema.toEncoded(DuplicateCandidateDetailResponseSchema),
      );
      if (detail.candidateParties.length !== 0 || detail.lifecycleState !== 'OPEN') {
        return { needsReview: true as const };
      }
      const resolved = yield* client.call(
        partyAudience,
        '/party-registry/actions/resolve-duplicate-candidate-create',
        Schema.toEncoded(ResolveDuplicateCandidateCreatePayloadSchema),
        {
          caseRef: created.caseRef,
          expectedRevision: detail.revision,
          reason: 'CRM client explicitly linked by the administrator; the case lists no candidate Party.',
        },
        Schema.toEncoded(ResolveDuplicateCandidateCreateResultSchema),
        true,
      );
      if (resolved.partyRef === null) {
        return { needsReview: true as const };
      }
      partyId = resolved.partyRef.resourceId;
    } else {
      partyId = created.partyRef.resourceId;
    }
    const partyRef = {
      moduleId: 'party.registry' as const,
      resourceId: partyId,
      resourceType: 'party.registry.party' as const,
      tenantId: client.target.tenantId,
    };
    const onboarded = yield* client.call(
      partyAudience,
      '/party-registry/actions/counterparty-customer-onboard',
      Schema.toEncoded(CounterpartyCustomerOnboardPayloadSchema),
      {
        counterpartyProvenance: {
          evidenceReference,
          method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
          reason: 'Existing CRM client of the company',
          source,
        },
        customerEvidence: {
          evidenceReference,
          method: 'APPROVED_PURCHASING_RELATIONSHIP',
          reason: 'Existing CRM client of the company',
          source,
        },
        partyRef,
        validFrom: now,
      },
      Schema.toEncoded(CounterpartyCustomerOnboardResultSchema),
      true,
    );
    const address = addressContactPoint(crmClient.address);
    const contactPoints = [
      ...(crmClient.email === undefined ? [] : [{ preferred: true, type: 'EMAIL' as const, value: crmClient.email }]),
      ...(crmClient.phone === undefined ? [] : [{ preferred: true, type: 'PHONE' as const, value: crmClient.phone }]),
      ...(address === undefined ? [] : [address]),
    ];
    for (const contactPoint of contactPoints) {
      yield* client
        .call(
          partyAudience,
          '/party-registry/actions/add-contact-point',
          Schema.toEncoded(AddContactPointPayloadSchema),
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
          Schema.toEncoded(AddContactPointResultSchema),
          true,
        )
        .pipe(
          // A malformed legacy phone / address must not block the identity link; the CRM card keeps the value.
          Effect.catchTag('DemoSeedError', (error) =>
            Console.log(`  ! ${crmClient.name}: kontaktní bod ${contactPoint.type} nepřijat (${error.reason})`),
          ),
        );
    }
    return { link: { counterpartyId: onboarded.counterpartyRef.resourceId, partyId }, needsReview: false as const };
  });

const configuration = Config.all({
  email: Config.String('ONTOS_DEMO_SEED_EMAIL').pipe(Config.withDefault('spravce@hanak.demo')),
  legalEntityId: Config.String('ONTOS_DEMO_SEED_LEGAL_ENTITY_ID').pipe(
    Config.withDefault('71000000-0000-4000-8000-000000000022'),
  ),
  password: Config.Redacted('ONTOS_DEMO_SEED_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234'))),
  shellUrl: Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020')),
  tenantId: Config.String('ONTOS_DEMO_SEED_TENANT_ID').pipe(Config.withDefault('70000000-0000-4000-8000-000000000020')),
});

const main = (apply: boolean) =>
  Effect.gen(function* linkParties() {
    const { email, password, ...target } = yield* configuration;
    const seed = yield* connectSeedClient(target, email, password);
    const client = { ...seed, target };
    const records = yield* client.call(crmAudience, '/reads/records', Empty, {}, CrmRecords);
    const customers = (yield* client.call(
      partyAudience,
      '/reads/customer-list',
      ListRequest,
      { includeArchived: true, limit: 500 },
      Customers,
    )).items;
    const linked = new Set(
      records.state.clients.items.flatMap((entry) =>
        entry.partyRef?.counterpartyId === undefined ? [] : [entry.partyRef.counterpartyId],
      ),
    );
    // Archived clients stay as they are (history only); restoring one offers the link on its card.
    const pending = records.state.clients.items.filter(
      (entry) => entry.status === 'active' && entry.partyRef?.counterpartyId === undefined,
    );
    yield* Console.log(
      `CRM ${target.legalEntityId}: ${records.state.clients.items.length} klientů, ${pending.length} aktivních bez PartyRef; registr: ${customers.length} zákazníků.`,
    );
    let revision = records.revision;
    const now = DateTime.formatIso(yield* DateTime.now);
    const summary = { created: 0, linked: 0, reused: 0, review: 0 };
    for (const crmClient of pending) {
      const existing = matchingCustomer(
        crmClient,
        customers.filter((customer) => !linked.has(customer.counterpartyId)),
      );
      yield* Console.log(
        `- ${crmClient.name}${crmClient.regNo === undefined ? '' : ` (IČO ${crmClient.regNo}${validIco(crmClient.regNo) ? '' : ', neplatný kontrolní součet'})`}: ${existing === undefined ? 'založit v registru' : `existující zákazník ${existing.displayName ?? ''}`}`,
      );
      if (!apply) {
        continue;
      }
      let link: { readonly counterpartyId: string; readonly partyId: string };
      if (existing === undefined) {
        const created = yield* createCustomer(client, crmClient, now);
        if (created.needsReview) {
          summary.review += 1;
          yield* Console.log('  ! shoda s jinou Party čeká na rozhodnutí v Zákaznících; nepropojeno');
          continue;
        }
        summary.created += 1;
        ({ link } = created);
      } else {
        summary.reused += 1;
        link = { counterpartyId: existing.counterpartyId, partyId: existing.partyId };
      }
      const result = yield* client.apply(
        crmAudience,
        LinkCommand,
        { _tag: 'LinkClientParty', clientId: crmClient.id, partyRef: link },
        revision,
        [partyAudience],
      );
      revision = result.revision;
      linked.add(link.counterpartyId);
      summary.linked += 1;
    }
    yield* Console.log(
      apply
        ? `Hotovo: propojeno ${summary.linked} (nově založeno ${summary.created}, existující ${summary.reused}), k rozhodnutí ${summary.review}.`
        : 'Jen náhled (bez --apply se nic nezapsalo).',
    );
  });

const command = Command.make(
  'link-party-registry',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) =>
    main(apply).pipe(
      Effect.catchTag('DemoSeedError', (error: DemoSeedError) => Console.error(`Chyba: ${error.reason}`)),
    ),
);

const mainLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(
    Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, ConfigProvider.layer(ConfigProvider.fromEnv())),
  ),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)));
