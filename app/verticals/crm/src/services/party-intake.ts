// Governed server-side Party Registry intake for CRM clients (CRM.md §3/§4, ADR-0015).
//
// A salesperson has no Party Registry rights (its customer list is company-wide), yet every active CRM client must
// carry a Party Registry identity. Right after a CRM command that made a client active has COMMITTED (Nový klient,
// restore, approved AI proposal, SyncClientParties), the CRM server runs this reconciliation as the dedicated
// non-human principal "CRM · zakládání klientů v Party Registry" (managed API key, scripts/demo/crm-party-intake.mts):
//   1. reads the company's CRM clients without identity (demo.crm.read_all of that principal);
//   2. reuses the matching current registry CUSTOMER (IČO, else name) or creates Party + CUSTOMER Counterparty +
//      Contact Points through the registry's public Actions;
//   3. stores the link with the CRM `LinkClientParty` Action, forwarding its own registry credential so the CRM
//      re-reads the Counterparty before storing it.
// Core authorizes and audits every step for that principal; the salesperson never receives registry access and the
// browser never sends a registry claim. It runs outside the CRM transaction: a registry Action started inside an
// open CRM Action transaction would wait on the same tenant row lock.
import type { RecordsRequestEncoded } from '../../shared/apis/records.ts';
import { CrmReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { EntityIdSchema, IcoSchema, RegistryCompanyIdSchema } from '../../shared/domain/common.ts';

import {
  AddContactPointPayloadSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  CreatePartyPayloadSchema,
} from '@app/party-registry/api';
import {
  addContactPointWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
  createPartyWithAuthorization,
  executeCustomerListWithAuthorization,
  executeDuplicateCandidateDetailWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
} from '@app/party-registry/api/client';
import { Config, Context, DateTime, Effect, FileSystem, Option, Redacted, Ref, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

import { VerifiedPartySchema } from '../../shared/commands/context.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';

import type { ClientSchema } from '../../shared/domain/clients.ts';
import { PartyIntakeSteps } from './party-intake-steps.ts';
import { PartyIntakeCompany } from './party-intake-company.ts';
import { PartyIntakeCorrelation } from './party-intake-correlation.ts';

export { PartyIntakeSteps } from './party-intake-steps.ts';
export { PartyIntakeCompany } from './party-intake-company.ts';
export { PartyIntakeCorrelation } from './party-intake-correlation.ts';

const REGISTRY = 'party-registry';
const CRM = 'crm';
const KEY_VARIABLE = 'ONTOS_CRM_PARTY_INTAKE_API_KEY';
/** At most this many clients per reconciliation (one request stays short). */
const BATCH = 20;
const PROVENANCE_SOURCE = 'demo.crm.client-intake';

export type IntakeClient = Pick<
  typeof ClientSchema.Encoded,
  'address' | 'email' | 'id' | 'kind' | 'name' | 'phone' | 'regNo' | 'vatNo'
>;

const unavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(new CrmReferenceUnavailable({ code: 'crm_reference_unavailable', reason }), 'cause', {
    enumerable: false,
    value: cause,
  });

const registryDown = (cause: unknown) =>
  unavailable('Evidence zákazníků je dočasně nedostupná; klienta teď nelze zapsat s ověřenou identitou', cause);

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('cs')
    .replaceAll(/\s+/gu, ' ')
    .trim();

/** Czech IČO checksum; the registry refuses an invalid one, so such a value is not sent as an identifier. */
export const validIco = Schema.is(IcoSchema);

/** "Ulice 12, 602 00 Brno" -> the registry ADDRESS Contact Point (only when street and PSČ + city are present). */
export const addressContactPoint = (address: string | undefined) => {
  const parts = (address ?? '').split(',').map((part) => part.trim());
  const zip = /^(?<postalCode>\d{3}\s?\d{2})\s+(?<city>.+)$/u.exec(parts.at(-1) ?? '');
  if (zip === null || parts.length < 2) {
    return [];
  }
  return [
    {
      address: {
        addressLine1: parts.slice(0, -1).join(', '),
        city: zip[2] ?? '',
        countryCode: 'CZ',
        postalCode: zip[1] ?? '',
      },
      purposes: [{ preferred: true, purpose: 'CORRESPONDENCE' }],
      type: 'ADDRESS',
    },
  ];
};

const contactPointsOf = (client: IntakeClient) => [
  ...(client.email === undefined ? [] : [{ preferred: true, type: 'EMAIL', value: client.email }]),
  ...(client.phone === undefined
    ? []
    : [
        client.phone.startsWith('+')
          ? { preferred: true, type: 'PHONE', value: client.phone }
          : { countryCode: 'CZ', preferred: true, type: 'PHONE', value: client.phone },
      ]),
  ...addressContactPoint(client.address),
];

export const RegistryCustomerSchema = Schema.Struct({
  companyId: Schema.OptionFromNullOr(RegistryCompanyIdSchema),
  counterpartyId: EntityIdSchema,
  displayName: Schema.OptionFromNullOr(Schema.String),
  partyId: EntityIdSchema,
  status: Schema.String,
});
export type RegistryCustomer = typeof RegistryCustomerSchema.Type;
export type RegistryCustomerInput = typeof RegistryCustomerSchema.Encoded;

/** IČO without inner whitespace ("270 82 440" = "27082440"); empty = none. */
export const normalizedIco = (value: string | null | undefined) => (value ?? '').replaceAll(/\s+/gu, '');

/**
 * The current registry customer this client already is. The same IČO proves the same organization, so that
 * customer is reused even when another CRM client (a duplicate entry) already holds it. Without IČO only the same
 * name matches, and never a customer another CRM client holds: a lookalike name alone is no evidence (CRM.md l.210),
 * such a client gets its own Party.
 */
export const matchingRegistryCustomer = (
  client: Pick<IntakeClient, 'name' | 'regNo'>,
  customers: readonly RegistryCustomer[],
  taken: ReadonlySet<string>,
) => {
  const ico = normalizedIco(client.regNo);
  return customers.find((customer) => {
    if (customer.status !== 'ACTIVE') {
      return false;
    }
    if (ico !== '') {
      return normalizedIco(Option.getOrElse(customer.companyId, () => '')) === ico;
    }
    return (
      !taken.has(customer.counterpartyId) &&
      !taken.has(customer.partyId) &&
      Option.isSome(customer.displayName) &&
      fold(customer.displayName.value) === fold(client.name)
    );
  });
};

/**
 * The registry customer of another CRM client with the same IČO (the same organization entered twice), when the
 * registry still lists it as an ACTIVE customer. Covers IČOs the registry does not hold as an identifier.
 */
export const sameIcoClientCustomer = (
  client: Pick<IntakeClient, 'id' | 'regNo'>,
  crmClients: readonly {
    readonly id: string;
    readonly partyRef?: { readonly counterpartyId?: string | undefined; readonly partyId: string } | undefined;
    readonly regNo?: string | undefined;
  }[],
  customers: readonly RegistryCustomer[],
) => {
  const ico = normalizedIco(client.regNo);
  const holders = crmClients.filter(
    (entry) => entry.id !== client.id && entry.partyRef !== undefined && normalizedIco(entry.regNo) === ico,
  );
  return ico === ''
    ? undefined
    : customers.find(
        (customer) =>
          customer.status === 'ACTIVE' &&
          holders.some(
            (entry) =>
              entry.partyRef?.counterpartyId === customer.counterpartyId && entry.partyRef.partyId === customer.partyId,
          ),
      );
};

/**
 * What the intake does with an OPEN registry duplicate case raised by its Create. Candidates found only by weak
 * evidence (a lookalike name or contact) are not the same subject: the case is resolved as a NEW Party, never merged
 * (C01-02). A candidate proven by an official identifier (IČO / DIČ) needs an identity reviewer.
 */
export const ambiguousCaseDecision = (detail: {
  readonly evaluatedEvidence: readonly { readonly identifierType?: string | undefined }[];
  readonly lifecycleState: string;
}): 'create' | 'review' =>
  detail.lifecycleState === 'OPEN' && detail.evaluatedEvidence.every((entry) => entry.identifierType === undefined)
    ? 'create'
    : 'review';

/** A CRM client as the intake reads it: identity fields, status and the stored registry link. */
export type IntakeCrmClient = IntakeClient & {
  readonly partyRef?: { readonly counterpartyId?: string | undefined; readonly partyId: string } | undefined;
  readonly status: string;
};

/**
 * Gives every target its registry identity, one client after another. A link made earlier in the same batch is
 * carried forward: later targets see it as a linked CRM client and its Party as taken, and a later target with the
 * same IČO reuses that identity directly (two clients entered together are the same organization, CRM.md l.210),
 * even before the registry customer list shows the new customer. One client's refused registry step must not leave
 * the remaining clients without identity: it counts as waiting for review.
 */
export const linkClientsInBatch = Effect.fn('Crm.partyIntake.linkBatch')(function* linkClientsInBatch(
  items: readonly IntakeCrmClient[],
  targets: readonly IntakeCrmClient[],
  initialRevision: number,
) {
  const steps = yield* PartyIntakeSteps;
  interface Progress {
    readonly linked: number;
    readonly linkedByIco: ReadonlyMap<string, VerifiedParty>;
    readonly review: number;
    readonly revision: number;
    readonly taken: ReadonlySet<string>;
    readonly working: readonly IntakeCrmClient[];
  }
  const outcome = yield* Effect.reduce(
    targets,
    (): Progress => ({
      linked: 0,
      linkedByIco: new Map<string, VerifiedParty>(),
      review: 0,
      revision: initialRevision,
      taken: new Set(
        items.flatMap((client) => {
          if (client.partyRef === undefined) {
            return [];
          }
          const ids = [client.partyRef.partyId];
          if (client.partyRef.counterpartyId !== undefined) {
            ids.push(client.partyRef.counterpartyId);
          }
          return ids;
        }),
      ),
      working: [...items],
    }),
    Effect.fn('Crm.partyIntake.linkBatchClient')(function* linkBatchClient(
      progress: Progress,
      client: IntakeCrmClient,
    ) {
      const ico = normalizedIco(client.regNo);
      const sameBatchParty = ico === '' ? undefined : progress.linkedByIco.get(ico);
      const linked = yield* (
        sameBatchParty === undefined
          ? steps.identify(client, progress.taken, progress.working)
          : Effect.succeedSome(sameBatchParty)
      ).pipe(
        Effect.flatMap((verified) =>
          Option.isNone(verified)
            ? Effect.succeed(Option.none<{ readonly party: VerifiedParty; readonly revision: number }>())
            : steps
                .link(client.id, verified.value, progress.revision)
                .pipe(Effect.map((revision) => Option.some({ party: verified.value, revision }))),
        ),
        Effect.catch((error) =>
          Effect.logWarning('CRM Evidence zákazníků intake skipped a client', client.id, error).pipe(
            Effect.as(Option.none<{ readonly party: VerifiedParty; readonly revision: number }>()),
          ),
        ),
      );
      if (Option.isNone(linked)) {
        return { ...progress, review: progress.review + 1 };
      }
      const { party, revision } = linked.value;
      const taken = new Set([...progress.taken, party.counterpartyId, party.partyId]);
      const linkedByIco = new Map(progress.linkedByIco);
      if (ico !== '') {
        linkedByIco.set(ico, party);
      }
      return {
        ...progress,
        linked: progress.linked + 1,
        linkedByIco,
        revision,
        taken,
        working: progress.working.map((entry) =>
          entry.id === client.id
            ? { ...entry, partyRef: { counterpartyId: party.counterpartyId, partyId: party.partyId } }
            : entry,
        ),
      };
    }),
  );
  return { linked: outcome.linked, review: outcome.review };
});

const GatewayContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String,
  compositionRevision: Schema.String,
  token: Schema.RedactedFromValue(Schema.String),
});

/** A local intake setting: the environment, else the gitignored demo secrets file app/.env.demo.local. */
const localSetting = Effect.fn('Crm.partyIntake.localSetting')(
  function* localSetting(name: string) {
    const fromEnvironment = yield* Config.option(Config.Redacted(name));
    if (Option.isSome(fromEnvironment)) {
      const value = Redacted.value(fromEnvironment.value).trim();
      if (value !== '') {
        return Option.some(Redacted.make(value));
      }
    }
    const file = yield* Config.String('ONTOS_DEMO_LOCAL_ENV_FILE').pipe(Config.withDefault('../../.env.demo.local'));
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    if (Option.isNone(fileSystem)) {
      return Option.none<Redacted.Redacted>();
    }
    const text = yield* fileSystem.value.readFileString(file).pipe(
      Effect.timeout('5 seconds'),
      Effect.orElseSucceed(() => ''),
    );
    const line = text.split('\n').find((entry) => entry.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim() ?? '';
    return value === '' ? Option.none<Redacted.Redacted>() : Option.some(Redacted.make(value));
  },
  Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
);

const CrmClientSchema = Schema.Struct({
  address: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  id: EntityIdSchema,
  kind: Schema.Literals(['organization', 'person']),
  name: Schema.String,
  partyRef: Schema.optionalKey(
    Schema.Struct({ counterpartyId: Schema.optionalKey(EntityIdSchema), partyId: EntityIdSchema }),
  ),
  phone: Schema.optionalKey(Schema.String),
  regNo: Schema.optionalKey(Schema.String),
  status: Schema.String,
  vatNo: Schema.optionalKey(Schema.String),
});
const CrmRecordsSchema = Schema.Struct({
  revision: Schema.Int,
  state: Schema.Struct({ clients: Schema.Struct({ items: Schema.Array(CrmClientSchema) }) }),
});
const RevisionSchema = Schema.Struct({ revision: Schema.Int });
const ReferenceCredentialsJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ audience: Schema.String, authorization: Schema.RedactedFromValue(Schema.String) })),
);

/**
 * Party Registry intake for one company. `identify` returns the registry identity of a client, `Option.none()` when
 * the registry holds a lookalike Party that needs an identity reviewer (the client stays unlinked; the správce sees
 * it on the Klienti page), or fails when the registry or the intake principal is unavailable.
 */
export class PartyIntake extends Context.Service<
  PartyIntake,
  {
    readonly reconcile: (
      clientIds: readonly string[],
    ) => Effect.Effect<
      { readonly linked: number; readonly review: number },
      CrmReferenceUnavailable,
      PartyIntakeCompany | PartyIntakeCorrelation
    >;
  }
>()('@app/crm/services/party-intake/PartyIntake') {}

export const partyIntakeServices = Effect.gen(function* partyIntakeServices() {
  const scope = yield* PartyIntakeCompany;
  const correlationId = yield* PartyIntakeCorrelation;
  const compositionRevision = yield* Ref.make(scope.compositionRevision);

  /** One single-use gateway assertion of the intake principal for `audience`. */
  const assertion = Effect.fn('Crm.issueAssertion')(function* issueAssertion(audience: string) {
    const key = yield* localSetting(KEY_VARIABLE);
    if (Option.isNone(key)) {
      return yield* unavailable(
        'Zápis klientů do evidence zákazníků není nastaven (chybí klíč služby CRM); požádejte správce systému',
      );
    }
    const gatewayBase = yield* Config.String('ONTOS_SHELL_GATEWAY_BASE_URL').pipe(
      Config.withDefault('http://127.0.0.1:3020/shell-super-app-api'),
      Effect.mapError(registryDown),
    );
    const http = yield* HttpClient.HttpClient;
    const currentCompositionRevision = yield* Ref.get(compositionRevision);
    const response = yield* HttpClientRequest.post(`${gatewayBase}/auth/api-key/gateway-context`).pipe(
      HttpClientRequest.setHeaders({ 'x-api-key': Redacted.value(key.value), 'x-correlation-id': correlationId }),
      HttpClientRequest.bodyJsonUnsafe({
        audience,
        compositionRevision: currentCompositionRevision,
        legalEntityId: scope.legalEntityId,
      }),
      http.execute,
      Effect.timeout('15 seconds'),
      Effect.mapError(registryDown),
    );
    if (response.status !== 200) {
      return yield* registryDown({ audience, operation: 'gateway-context', status: response.status });
    }
    const context = yield* HttpClientResponse.schemaBodyJson(GatewayContextSchema)(response).pipe(
      Effect.mapError(registryDown),
    );
    yield* Ref.set(compositionRevision, context.compositionRevision);
    const credential = Redacted.make(`Bearer ${Redacted.value(context.token)}`);
    return {
      authorization: credential,
      credential,
      options: {
        baseUrl: new URL(context.apiBaseUrl, new URL(gatewayBase).origin).href,
        compositionRevision: context.compositionRevision,
      },
    };
  });

  const customers = Effect.gen(function* loadCustomers() {
    const { credential, options } = yield* assertion(REGISTRY);
    const list = yield* executeCustomerListWithAuthorization(
      { includeArchived: false, limit: 500 },
      Redacted.value(credential),
      correlationId,
      options,
    ).pipe(Effect.mapError(registryDown));
    return yield* Schema.decodeEffect(Schema.Array(RegistryCustomerSchema))(list.items).pipe(
      Effect.mapError(registryDown),
    );
  });

  const createCustomer = Effect.fn('Crm.partyIntake.create')(function* createCustomer(
    client: IntakeClient,
    operationKey: string,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const evidenceReference = `crm-client:${client.id}`.slice(0, 200);
    const organization = client.kind === 'organization';
    const createPayload = yield* Schema.decodeUnknownEffect(CreatePartyPayloadSchema)({
      candidate: {
        displayName: client.name,
        evidenceRefs: [evidenceReference],
        officialIdentifiers: [
          ...(organization && validIco(client.regNo)
            ? [{ identifierType: 'ICO', value: client.regNo, verification: 'UNVERIFIED' }]
            : []),
          ...(organization && client.vatNo !== undefined && /^CZ\d{8,10}$/u.test(client.vatNo.toUpperCase())
            ? [{ identifierType: 'CZ_DIC', value: client.vatNo.toUpperCase(), verification: 'UNVERIFIED' }]
            : []),
        ],
        partyType: organization ? 'ORGANIZATION' : 'PERSON',
        provenance: { method: 'MANUAL_ENTRY', source: PROVENANCE_SOURCE },
        subjectEvidence: [
          {
            basis: 'DIRECT_INTERACTION',
            evidenceRef: evidenceReference,
            kind: 'ACTOR_ATTESTATION',
            observedSubject: organization ? 'ORGANIZATION' : 'PERSON',
            statement: `CRM client ${client.name} entered by an authorized CRM user`,
            subjectKey: evidenceReference,
          },
        ],
        validFrom: now,
      },
    }).pipe(Effect.mapError(registryDown));
    const first = yield* assertion(REGISTRY);
    const created = yield* createPartyWithAuthorization(createPayload, Redacted.value(first.credential), {
      ...first.options,
      correlationId,
      idempotencyKey: `${operationKey}:party`,
    }).pipe(Effect.mapError(registryDown));
    let partyRef = created.outcome === 'AMBIGUOUS' ? undefined : created.partyRef;
    if (created.outcome === 'AMBIGUOUS') {
      const second = yield* assertion(REGISTRY);
      const detail = yield* executeDuplicateCandidateDetailWithAuthorization(
        { caseRef: created.caseRef },
        Redacted.value(second.credential),
        correlationId,
        second.options,
      ).pipe(Effect.mapError(registryDown));
      // Only lookalikes (e.g. a client with the same name): a distinct new Party, never merged (C01-02).
      // An official-identifier candidate waits for an identity reviewer.
      if (ambiguousCaseDecision(detail) === 'review') {
        return Option.none<VerifiedParty>();
      }
      const third = yield* assertion(REGISTRY);
      const resolved = yield* resolveDuplicateCandidateCreateWithAuthorization(
        {
          caseRef: created.caseRef,
          expectedRevision: detail.revision,
          reason:
            'New CRM client; the candidate Parties share only a lookalike name or contact, no official identifier',
        },
        Redacted.value(third.credential),
        { ...third.options, correlationId, idempotencyKey: `${operationKey}:resolve-create` },
      ).pipe(Effect.mapError(registryDown));
      if (resolved.partyRef === null) {
        return Option.none<VerifiedParty>();
      }
      ({ partyRef } = resolved);
    }
    if (partyRef === undefined) {
      return Option.none<VerifiedParty>();
    }
    const onboardPayload = yield* Schema.decodeEffect(CounterpartyCustomerOnboardPayloadSchema)({
      counterpartyProvenance: {
        evidenceReference,
        method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
        reason: 'Client of the company recorded in CRM',
        source: PROVENANCE_SOURCE,
      },
      customerEvidence: {
        evidenceReference,
        method: 'APPROVED_PURCHASING_RELATIONSHIP',
        reason: 'Client of the company recorded in CRM',
        source: PROVENANCE_SOURCE,
      },
      partyRef,
      validFrom: now,
    }).pipe(Effect.mapError(registryDown));
    const fourth = yield* assertion(REGISTRY);
    const onboarded = yield* counterpartyCustomerOnboardWithAuthorization(
      onboardPayload,
      Redacted.value(fourth.credential),
      {
        ...fourth.options,
        correlationId,
        idempotencyKey: `${operationKey}:onboard`,
      },
    ).pipe(Effect.mapError(registryDown));
    const contactPoints = contactPointsOf(client);
    // A malformed legacy phone or address must not block the identity; the CRM card keeps the value.
    yield* Effect.forEach(
      contactPoints,
      Effect.fn('Crm.partyIntake.addContact')(
        function* addContact(contactPoint: (typeof contactPoints)[number], index: number) {
          const payload = yield* Schema.decodeUnknownEffect(AddContactPointPayloadSchema)({
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
          });
          const { credential, options } = yield* assertion(REGISTRY);
          return yield* addContactPointWithAuthorization(payload, Redacted.value(credential), {
            ...options,
            correlationId,
            idempotencyKey: `${operationKey}:contact:${index}`,
          });
        },
        (effect) => effect.pipe(Effect.ignore),
      ),
      { concurrency: 1, discard: true },
    );
    const verified = yield* Schema.decodeEffect(VerifiedPartySchema)({
      counterpartyId: onboarded.counterpartyRef.resourceId,
      displayName: client.name,
      partyId: partyRef.resourceId,
    }).pipe(Effect.mapError(registryDown));
    return Option.some(verified);
  });

  /**
   * Reuses the matching current registry customer or creates the Party + CUSTOMER Counterparty with the client's
   * e-mail, phone and address as Contact Points. `taken` = counterparty and party ids already linked in the CRM.
   */
  const identify = Effect.fn('Crm.partyIntake.identify')(function* identify(
    client: IntakeClient,
    taken: ReadonlySet<string>,
    operationKey: string,
    crmClients: Parameters<typeof sameIcoClientCustomer>[1] = [],
  ) {
    const registryCustomers = yield* customers;
    const existing =
      sameIcoClientCustomer(client, crmClients, registryCustomers) ??
      matchingRegistryCustomer(client, registryCustomers, taken);
    if (existing !== undefined) {
      const candidate = {
        counterpartyId: existing.counterpartyId,
        partyId: existing.partyId,
      };
      if (Option.isSome(existing.displayName)) {
        Object.assign(candidate, { displayName: existing.displayName.value });
      }
      return Option.some(
        yield* Schema.decodeEffect(VerifiedPartySchema)(candidate).pipe(Effect.mapError(registryDown)),
      );
    }
    return yield* createCustomer(client, operationKey);
  });

  type IntakeHttpBody = RecordsRequestEncoded | typeof ApplyCommandPayloadSchema.Encoded;
  interface IntakeHttpHeaders {
    readonly authorization: Redacted.Redacted;
    readonly 'idempotency-key'?: string;
    readonly 'x-ontos-composition-revision': string;
    readonly 'x-ontos-reference-credentials'?: Redacted.Redacted;
  }
  const postJson = Effect.fn('Crm.postJsonRequest')(function* postJsonRequest(
    url: string,
    body: IntakeHttpBody,
    headers: IntakeHttpHeaders,
  ) {
    const http = yield* HttpClient.HttpClient;
    const wireHeaders = {
      authorization: Redacted.value(headers.authorization),
      'x-correlation-id': correlationId,
      'x-ontos-composition-revision': headers['x-ontos-composition-revision'],
    };
    if (headers['idempotency-key'] !== undefined) {
      Object.assign(wireHeaders, { 'idempotency-key': headers['idempotency-key'] });
    }
    if (headers['x-ontos-reference-credentials'] !== undefined) {
      Object.assign(wireHeaders, {
        'x-ontos-reference-credentials': Redacted.value(headers['x-ontos-reference-credentials']),
      });
    }
    return yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(wireHeaders),
      HttpClientRequest.bodyJsonUnsafe(body),
      http.execute,
      Effect.timeout('20 seconds'),
      Effect.mapError(registryDown),
    );
  });

  /** The company's CRM clients as the intake principal sees them (read_all). */
  const crmRecords = Effect.gen(function* readCrmRecords() {
    const crm = yield* assertion(CRM);
    const response = yield* postJson(
      `${crm.options.baseUrl}/reads/records`,
      {},
      {
        authorization: crm.authorization,
        'x-ontos-composition-revision': crm.options.compositionRevision,
      },
    );
    if (response.status !== 200) {
      return yield* registryDown({ operation: 'crm-records', status: response.status });
    }
    return yield* HttpClientResponse.schemaBodyJson(CrmRecordsSchema)(response).pipe(Effect.mapError(registryDown));
  });

  /** Stores the link through the CRM Action; the CRM re-reads the Counterparty with the forwarded credential. */
  const linkClient = Effect.fn('Crm.partyIntake.link')(function* linkClient(
    clientId: string,
    party: VerifiedParty,
    expectedRevision: number,
    operationKey: string,
  ) {
    const crm = yield* assertion(CRM);
    const registry = yield* assertion(REGISTRY);
    const response = yield* postJson(
      `${crm.options.baseUrl}/crm/actions/apply-command`,
      {
        command: {
          _tag: 'LinkClientParty',
          clientId,
          partyRef: { counterpartyId: party.counterpartyId, partyId: party.partyId },
        },
        expectedRevision,
      },
      {
        authorization: crm.authorization,
        'idempotency-key': `${operationKey}:link`,
        'x-ontos-composition-revision': crm.options.compositionRevision,
        'x-ontos-reference-credentials': Redacted.make(
          yield* Schema.encodeEffect(ReferenceCredentialsJsonSchema)([
            { audience: REGISTRY, authorization: registry.authorization },
          ]).pipe(Effect.mapError(registryDown)),
        ),
      },
    );
    if (response.status !== 200) {
      const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
      return yield* registryDown({
        detail: detail.slice(0, 300),
        operation: 'LinkClientParty',
        status: response.status,
      });
    }
    return (yield* HttpClientResponse.schemaBodyJson(RevisionSchema)(response).pipe(Effect.mapError(registryDown)))
      .revision;
  });

  /**
   * Gives every active client without identity (plus `clientIds`, also archived ones) its registry identity and
   * stores the link. Returns how many clients were linked and how many wait for an identity reviewer.
   */
  const reconcile = Effect.fn('Crm.partyIntake.reconcile')(function* reconcile(clientIds: readonly string[]) {
    const records = yield* crmRecords;
    const { items } = records.state.clients;
    const requestedIds = new Set(clientIds);
    const targets = items
      .filter((client) => client.partyRef === undefined && (client.status === 'active' || requestedIds.has(client.id)))
      .slice(0, BATCH);
    return yield* linkClientsInBatch(items, targets, records.revision);
  });

  return {
    identify: (client: IntakeCrmClient, taken: ReadonlySet<string>, crmClients: readonly IntakeCrmClient[]) =>
      identify(client, taken, `crm-intake:${correlationId}:${client.id}`.slice(0, 180), crmClients),
    link: (clientId: string, party: VerifiedParty, expectedRevision: number) =>
      linkClient(clientId, party, expectedRevision, `crm-intake:${correlationId}:${clientId}`.slice(0, 180)),
    reconcile,
  };
});
