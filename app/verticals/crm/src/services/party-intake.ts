// @effect-diagnostics strictEffectProvide:off nodeBuiltinImport:off
// Governed server-side Party Registry intake for CRM clients (CRM.md §3/§4, ADR-0015).
//
// A salesperson has no Party Registry rights (its customer list is company-wide), yet every active CRM client must
// carry a Party Registry identity. After the CRM has checked the caller's own CRM write rights, this step creates or
// reuses the registry Party + CUSTOMER Counterparty through the registry's public Actions, authenticated as the
// dedicated non-human principal "CRM · zakládání klientů v Party Registry" (managed API key, provisioned by
// scripts/demo/crm-party-intake.mts). Core checks that principal's narrow grants and audits every registry write;
// the salesperson never receives registry access and the browser never sends a registry claim.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
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
import { Config, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

import { CrmReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import type { Client } from '../../shared/domain/clients.ts';

const AUDIENCE = 'party-registry';
const KEY_VARIABLE = 'ONTOS_CRM_PARTY_INTAKE_API_KEY';
const GATEWAY_PATH = '/shell-super-app-api/auth/api-key/gateway-context';
const PROVENANCE_SOURCE = 'demo.crm.client-intake';

export type IntakeClient = Pick<Client, 'address' | 'email' | 'id' | 'kind' | 'name' | 'phone' | 'regNo' | 'vatNo'>;

const unavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(new CrmReferenceUnavailable({ code: 'crm_reference_unavailable', reason }), 'cause', {
    enumerable: false,
    value: cause,
  });

const registryDown = (cause: unknown) =>
  unavailable('Party Registry je dočasně nedostupný; klienta teď nelze zapsat s ověřenou identitou', cause);

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('cs')
    .replaceAll(/\s+/gu, ' ')
    .trim();

/** Czech IČO checksum; the registry refuses an invalid one, so such a value is not sent as an identifier. */
export const validIco = (value: string | undefined): value is string => {
  if (value === undefined || !/^\d{8}$/u.test(value)) {
    return false;
  }
  const digits = [...value].map(Number);
  const sum = digits.slice(0, 7).reduce((total, digit, index) => total + digit * (8 - index), 0);
  return (11 - (sum % 11)) % 10 === digits[7];
};

/** "Ulice 12, 602 00 Brno" -> the registry ADDRESS Contact Point (only when street and PSČ + city are present). */
export const addressContactPoint = (address: string | undefined) => {
  const parts = (address ?? '').split(',').map((part) => part.trim());
  const zip = /^(\d{3}\s?\d{2})\s+(.+)$/u.exec(parts.at(-1) ?? '');
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

export interface RegistryCustomer {
  readonly companyId: string | null;
  readonly counterpartyId: string;
  readonly displayName: string | null;
  readonly partyId: string;
  readonly status: string;
}

/**
 * The current registry customer this client already is: the same IČO, or (without IČO) the same name. Customers
 * already linked to another CRM client are skipped (one Party is one CRM client).
 */
export const matchingRegistryCustomer = (
  client: Pick<IntakeClient, 'name' | 'regNo'>,
  customers: readonly RegistryCustomer[],
  taken: ReadonlySet<string>,
) =>
  customers.find(
    (customer) =>
      customer.status === 'ACTIVE' &&
      !taken.has(customer.counterpartyId) &&
      !taken.has(customer.partyId) &&
      (client.regNo === undefined || client.regNo.trim() === ''
        ? customer.displayName !== null && fold(customer.displayName) === fold(client.name)
        : customer.companyId !== null && customer.companyId.replaceAll(/\s+/gu, '') === client.regNo.trim()),
  );

const GatewayContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String,
  compositionRevision: Schema.String,
  token: Schema.String,
});

/** The intake principal's managed API key: the environment, else the local demo secrets file (gitignored). */
const intakeKey = Effect.gen(function* readIntakeKey() {
  const fromEnvironment = yield* Config.option(Config.Redacted(KEY_VARIABLE));
  if (Option.isSome(fromEnvironment)) {
    return Option.some(fromEnvironment.value);
  }
  const file = yield* Config.String('ONTOS_DEMO_LOCAL_ENV_FILE').pipe(
    Config.withDefault(join(process.cwd(), '../../.env.demo.local')),
  );
  const text = yield* Effect.tryPromise(() => readFile(file, 'utf8')).pipe(Effect.orElseSucceed(() => ''));
  const line = text.split('\n').find((entry) => entry.startsWith(`${KEY_VARIABLE}=`));
  const value = line?.slice(KEY_VARIABLE.length + 1).trim() ?? '';
  return value === '' ? Option.none<Redacted.Redacted<string>>() : Option.some(Redacted.make(value));
}).pipe(Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()));

/**
 * Party Registry intake for one company (the CRM command's scoped legal entity). `identify` returns the verified
 * registry identity of a client, `Option.none()` when the registry holds a lookalike Party that needs an identity
 * reviewer (the client stays unlinked and the správce resolves it on the card), or fails when the registry or the
 * intake principal is unavailable.
 */
export const makePartyIntake = Effect.fn('Crm.makePartyIntake')(function* makePartyIntake(scope: {
  readonly correlationId?: string | undefined;
  readonly legalEntityId: string;
  readonly tenantId: string;
}) {
  const composition = yield* ActiveApplicationCompositionService;
  const correlationId = scope.correlationId ?? `crm-intake-${randomUUID()}`;

  /** One single-use registry assertion of the intake principal. */
  const assertion = Effect.gen(function* issueAssertion() {
    const key = yield* intakeKey;
    if (Option.isNone(key)) {
      return yield* unavailable(
        'Zápis klientů do Party Registry není nastaven (chybí klíč služby CRM); požádejte správce systému',
      );
    }
    const snapshot = yield* composition.load.pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
      Effect.mapError(registryDown),
    );
    const shellUrl = snapshot.composition.shell.runtimeContract.url;
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(new URL(GATEWAY_PATH, shellUrl).href).pipe(
      HttpClientRequest.setHeaders({
        'x-api-key': Redacted.value(key.value),
        'x-correlation-id': correlationId,
      }),
      HttpClientRequest.bodyJsonUnsafe({
        audience: AUDIENCE,
        compositionRevision: snapshot.composition.revision,
        legalEntityId: scope.legalEntityId,
      }),
      http.execute,
      Effect.timeout('15 seconds'),
      Effect.mapError(registryDown),
    );
    if (response.status !== 200) {
      return yield* registryDown(new Error(`intake gateway-context HTTP ${response.status}`));
    }
    const context = yield* HttpClientResponse.schemaBodyJson(GatewayContextSchema)(response).pipe(
      Effect.mapError(registryDown),
    );
    return {
      credential: `Bearer ${context.token}`,
      options: {
        baseUrl: new URL(context.apiBaseUrl, shellUrl).href,
        compositionRevision: context.compositionRevision,
      },
    };
  }).pipe(Effect.provide(FetchHttpClient.layer));

  const customers = Effect.gen(function* loadCustomers() {
    const { credential, options } = yield* assertion;
    const list = yield* executeCustomerListWithAuthorization(
      { includeArchived: false, limit: 500 },
      credential,
      correlationId,
      options,
    ).pipe(Effect.mapError(registryDown));
    return list.items.map(
      (item): RegistryCustomer => ({
        companyId: item.companyId,
        counterpartyId: item.counterpartyId,
        displayName: item.displayName,
        partyId: item.partyId,
        status: item.status,
      }),
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
    const first = yield* assertion;
    const created = yield* createPartyWithAuthorization(createPayload, first.credential, {
      ...first.options,
      correlationId,
      idempotencyKey: `${operationKey}:party`,
    }).pipe(Effect.mapError(registryDown));
    let partyRef = created.outcome === 'AMBIGUOUS' ? undefined : created.partyRef;
    if (created.outcome === 'AMBIGUOUS') {
      const second = yield* assertion;
      const detail = yield* executeDuplicateCandidateDetailWithAuthorization(
        { caseRef: created.caseRef },
        second.credential,
        correlationId,
        second.options,
      ).pipe(Effect.mapError(registryDown));
      // A lookalike Party exists: an identity reviewer decides; never merged automatically (C01-02).
      if (detail.lifecycleState !== 'OPEN' || detail.candidateParties.length > 0) {
        return Option.none<VerifiedParty>();
      }
      const third = yield* assertion;
      const resolved = yield* resolveDuplicateCandidateCreateWithAuthorization(
        {
          caseRef: created.caseRef,
          expectedRevision: detail.revision,
          reason: 'New CRM client; the duplicate case lists no candidate Party',
        },
        third.credential,
        { ...third.options, correlationId, idempotencyKey: `${operationKey}:resolve-create` },
      ).pipe(Effect.mapError(registryDown));
      if (resolved.partyRef === null) {
        return Option.none<VerifiedParty>();
      }
      partyRef = resolved.partyRef;
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
    const fourth = yield* assertion;
    const onboarded = yield* counterpartyCustomerOnboardWithAuthorization(onboardPayload, fourth.credential, {
      ...fourth.options,
      correlationId,
      idempotencyKey: `${operationKey}:onboard`,
    }).pipe(Effect.mapError(registryDown));
    const contactPoints = contactPointsOf(client);
    for (const [index, contactPoint] of contactPoints.entries()) {
      // A malformed legacy phone or address must not block the identity; the CRM card keeps the value.
      yield* Schema.decodeUnknownEffect(AddContactPointPayloadSchema)({
        contactPoint,
        partyRef,
        privacyClassification: 'BUSINESS_SENSITIVE',
        provenance: { authoritative: false, evidenceReference, method: 'MANUAL_CONFIRMATION', source: 'USER_ASSERTION' },
        validFrom: now,
        verification: { state: 'UNVERIFIED' },
      }).pipe(
        Effect.flatMap((payload) =>
          assertion.pipe(
            Effect.flatMap(({ credential, options }) =>
              addContactPointWithAuthorization(payload, credential, {
                ...options,
                correlationId,
                idempotencyKey: `${operationKey}:contact:${index}`,
              }),
            ),
          ),
        ),
        Effect.ignore,
      );
    }
    return Option.some<VerifiedParty>({
      counterpartyId: onboarded.counterpartyRef.resourceId,
      displayName: client.name,
      partyId: partyRef.resourceId,
    });
  });

  /**
   * Reuses the matching current registry customer or creates the Party + CUSTOMER Counterparty with the client's
   * e-mail, phone and address as Contact Points. `taken` = counterparty and party ids already linked in the CRM.
   */
  const identify = Effect.fn('Crm.partyIntake.identify')(function* identify(
    client: IntakeClient,
    taken: ReadonlySet<string>,
    operationKey: string,
  ) {
    const existing = matchingRegistryCustomer(client, yield* customers, taken);
    if (existing !== undefined) {
      return Option.some<VerifiedParty>({
        counterpartyId: existing.counterpartyId,
        ...(existing.displayName === null ? {} : { displayName: existing.displayName }),
        partyId: existing.partyId,
      });
    }
    return yield* createCustomer(client, operationKey);
  });

  return { identify };
});

export type PartyIntake = Effect.Success<ReturnType<typeof makePartyIntake>>;
