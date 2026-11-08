// CRM client identity reconciliation uses its registered workload on purpose-only CRM operations.
// The native per-client Action reads the exact owner snapshot, then CRM's server module credential
// delegates for that same verified workload to Party Registry. Humans keep their ordinary CRM and
// Party rights. Registry effects run before CRM's final CAS write, never inside its SQL transaction.
import {
  AddContactPointPayloadSchema,
  CounterpartyCustomerOnboardPayloadSchema,
  CreatePartyPayloadSchema,
  ResolveDuplicateCandidateCreatePayloadSchema,
} from '@app/party-registry/api';
import { crmClientEvidenceReference } from '@app/party-registry/crm-client-evidence';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  addContactPointWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
  executeCreateCrmClientPartyWithAuthorization,
  executeCustomerListWithAuthorization,
  executeCrmClientIntakeReviewWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
} from '@app/party-registry/api/client';
import {
  Config,
  Crypto,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { OperationalScope } from '@app/core-runtime';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

import { CrmReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import { VerifiedPartySchema } from '../../shared/commands/context.ts';
import type { VerifiedParty } from '../../shared/commands/context.ts';
import type { ClientSchema } from '../../shared/domain/clients.ts';
import { EntityIdSchema, IcoSchema, RegistryCompanyIdSchema } from '../../shared/domain/common.ts';
import type { ClientPartySync } from '../../shared/apis/apply-command-action.ts';
import { executeIntakeClientPartyWithAuthorization } from '../api/intake-client-party-action-client.ts';
import { executePendingClientIntakeWithAuthorization } from '../api/pending-client-intake-client.ts';

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
        city: zip.groups?.['city'] ?? '',
        countryCode: 'CZ',
        postalCode: zip.groups?.['postalCode'] ?? '',
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

/**
 * The Party candidate name fields for one CRM client. Party Registry derives `displayName` from
 * `businessName` for organizations and from `firstName`/`lastName` for people, so the derived display
 * name stays equal to the name the CRM recorded.
 */
export const candidateNameFields = (client: Pick<IntakeClient, 'kind' | 'name'>) => {
  if (client.kind === 'organization') {
    return { businessName: client.name };
  }
  const [first = '', ...rest] = client.name.trim().split(/\s+/u);
  return rest.length === 0 ? { firstName: first } : { firstName: first, lastName: rest.join(' ') };
};

export const RegistryCustomerSchema = Schema.Struct({
  companyId: Schema.OptionFromNullOr(RegistryCompanyIdSchema),
  counterpartyId: EntityIdSchema,
  displayName: Schema.OptionFromNullOr(Schema.String),
  partyId: EntityIdSchema,
  status: Schema.String,
});
export type RegistryCustomer = typeof RegistryCustomerSchema.Type;

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
  return customers.find(
    (customer) =>
      ico !== '' &&
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
  readonly evaluatedEvidence?: readonly { readonly identifierType?: string | undefined }[];
  readonly lifecycleState: string;
}): 'create' | 'review' =>
  detail.lifecycleState === 'OPEN' &&
  detail.evaluatedEvidence !== undefined &&
  detail.evaluatedEvidence.length > 0 &&
  detail.evaluatedEvidence.every((entry) => entry.identifierType === undefined)
    ? 'create'
    : 'review';

/** A CRM client as the intake reads it: identity fields, status and the stored registry link. */
export type IntakeCrmClient = IntakeClient & {
  readonly partyRef?: { readonly counterpartyId?: string | undefined; readonly partyId: string } | undefined;
  readonly status: string;
};
type IdentifyClient<E, R> = (
  client: IntakeCrmClient,
  taken: ReadonlySet<string>,
  crmClients: readonly IntakeCrmClient[],
) => Effect.Effect<Option.Option<VerifiedParty>, E, R>;
type LinkClient<E, R> = (
  clientId: string,
  party: VerifiedParty,
  expectedRevision: number,
) => Effect.Effect<number, E, R>;

/**
 * Gives every target its registry identity, one client after another. A link made earlier in the same batch is
 * carried forward: later targets see it as a linked CRM client and its Party as taken, and a later target with the
 * same IČO reuses that identity directly (two clients entered together are the same organization, CRM.md l.210),
 * even before the registry customer list shows the new customer. One client's refused registry step must not leave
 * the remaining clients without identity: it counts as waiting for review.
 */
export const linkClientsInBatch = Effect.fn('Crm.partyIntake.linkBatch')(function* linkClientsInBatch<IE, IR, LE, LR>(
  items: readonly IntakeCrmClient[],
  targets: readonly IntakeCrmClient[],
  initialRevision: number,
  identify: IdentifyClient<IE, IR>,
  link: LinkClient<LE, LR>,
) {
  const initial = {
    failed: 0,
    linked: 0,
    linkedByIco: new Map<string, VerifiedParty>(),
    review: 0,
    revision: initialRevision,
    taken: new Set(
      items.flatMap((client) =>
        client.partyRef === undefined
          ? []
          : [
              client.partyRef.partyId,
              ...(client.partyRef.counterpartyId === undefined ? [] : [client.partyRef.counterpartyId]),
            ],
      ),
    ),
    working: [...items],
  };
  const linkNext = Effect.fn('Crm.partyIntake.linkNext')(function* linkNext(
    state: typeof initial,
    client: IntakeCrmClient,
  ) {
    const ico = normalizedIco(client.regNo);
    const sameBatchParty = ico === '' ? undefined : state.linkedByIco.get(ico);
    const linked = yield* (
      sameBatchParty === undefined ? identify(client, state.taken, state.working) : Effect.succeedSome(sameBatchParty)
    ).pipe(
      Effect.flatMap((verified) =>
        Option.isNone(verified)
          ? Effect.succeed(Option.none<{ readonly party: VerifiedParty; readonly revision: number }>())
          : link(client.id, verified.value, state.revision).pipe(
              Effect.map((next) => Option.some({ party: verified.value, revision: next })),
            ),
      ),
      Effect.result,
    );
    if (Result.isFailure(linked)) {
      yield* Effect.logWarning('CRM Evidence zákazníků intake skipped a client', client.id, linked.failure);
      return { ...state, failed: state.failed + 1 };
    }
    if (Option.isNone(linked.success)) {
      return { ...state, review: state.review + 1 };
    }
    const { party, revision } = linked.success.value;
    const taken = new Set([...state.taken, party.counterpartyId, party.partyId]);
    const linkedByIco = new Map(state.linkedByIco);
    if (ico !== '') {
      linkedByIco.set(ico, party);
    }
    return {
      ...state,
      linked: state.linked + 1,
      linkedByIco,
      revision,
      taken,
      working: state.working.map((entry) =>
        entry.id === client.id
          ? { ...entry, partyRef: { counterpartyId: party.counterpartyId, partyId: party.partyId } }
          : entry,
      ),
    };
  });
  const outcome = yield* Effect.reduce(targets, () => initial, linkNext);
  return { failed: outcome.failed, linked: outcome.linked, review: outcome.review };
});

interface IntakeRecords {
  readonly revision: number;
  readonly state: { readonly clients: { readonly items: readonly IntakeCrmClient[] } };
}

/** Both the selection and the completion read use CRM's canonical, governed records. */
export const reconcileClientPartyBatch = Effect.fn('Crm.partyIntake.reconcileBatch')(
  function* reconcileClientPartyBatch<RE, RR, IE, IR, LE, LR>(
    readRecords: () => Effect.Effect<IntakeRecords, RE, RR>,
    identify: IdentifyClient<IE, IR>,
    link: LinkClient<LE, LR>,
    clientIds?: readonly string[],
  ) {
    const before = yield* readRecords();
    const wanted = clientIds === undefined ? undefined : new Set(clientIds);
    const eligible = (client: IntakeCrmClient) =>
      wanted === undefined ? client.status === 'active' : wanted.has(client.id);
    const pending = before.state.clients.items.filter(
      (client) => eligible(client) && client.partyRef?.counterpartyId === undefined,
    );
    const targets = pending.slice(0, BATCH);
    const outcome = yield* linkClientsInBatch(before.state.clients.items, targets, before.revision, identify, link);
    const after = yield* readRecords().pipe(
      Effect.filterOrFail(
        (observed) => observed.revision >= before.revision + outcome.linked,
        () => unavailable('Dokončení propojení se nepodařilo ověřit v aktuálním stavu CRM'),
      ),
    );
    const linked = targets.filter((target) =>
      after.state.clients.items.some(
        (client) => client.id === target.id && client.partyRef?.counterpartyId !== undefined,
      ),
    ).length;
    const remaining = after.state.clients.items.filter(
      (client) => eligible(client) && client.partyRef?.counterpartyId === undefined,
    ).length;
    // A target disappearing is not a persisted link. Nor is a successful transport response without its write.
    const unverified = targets.length - linked;
    const failed = Math.max(outcome.failed, unverified - outcome.review);
    const complete = remaining === 0 && failed === 0 && outcome.review === 0;
    let status: Exclude<ClientPartySync['status'], 'unavailable'> = 'partial';
    if (complete) {
      status = linked === 0 ? 'unchanged' : 'complete';
    }
    return { failed, linked, remaining, review: outcome.review, status } satisfies ClientPartySync;
  },
);

/** The CRM command already committed; an intake outage must not turn it into a retryable Action failure. */
export const observeClientPartySync = Effect.fn('Crm.partyIntake.observe')(function* observeClientPartySync<E, R>(
  reconcile: Effect.Effect<ClientPartySync, E, R>,
) {
  return yield* reconcile.pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        'CRM registry link completion unavailable',
        Schema.is(CrmReferenceUnavailable)(error) ? error.code : 'intake_context_unavailable',
      ).pipe(Effect.as({ status: 'unavailable' as const })),
    ),
  );
});

const GatewayContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String,
  compositionRevision: Schema.String,
  token: Schema.RedactedFromValue(Schema.String),
});

const SHELL_API_PATH = '/shell-super-app-api';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const GatewayConfigurationUrlSchema = Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s\\]+$/u))
  .pipe(Schema.decodeTo(Schema.URLFromString))
  .check(
    Schema.makeFilter(
      (url) =>
        url.hostname !== '' && url.username === '' && url.password === '' && url.search === '' && url.hash === '',
    ),
  );

/** Only deployment configuration chooses the credential destination. There is no implicit local endpoint. */
const configuredGatewayBase = Effect.fn('Crm.partyIntake.gatewayBase')(function* configuredGatewayBase() {
  const configured = yield* Config.all({
    environment: Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')),
    explicit: Config.option(Config.String('ONTOS_SHELL_GATEWAY_BASE_URL')),
    issuer: Config.option(Config.String('ONTOS_GATEWAY_ISSUER')),
  }).pipe(Effect.mapError(registryDown));
  // A present but malformed override is a configuration failure, not permission to try another destination.
  const source = Option.orElse(configured.explicit, () => configured.issuer);
  if (Option.isNone(source)) {
    return yield* registryDown({ operation: 'gateway-configuration' });
  }
  const url = yield* Schema.decodeEffect(GatewayConfigurationUrlSchema)(source.value).pipe(
    Effect.mapError(registryDown),
  );
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const local = loopback && Option.contains(configured.environment, 'development');
  if (
    (!local && (loopback || url.protocol !== 'https:')) ||
    (Option.isSome(configured.explicit) && url.pathname !== SHELL_API_PATH && url.pathname !== `${SHELL_API_PATH}/`)
  ) {
    return yield* registryDown({ operation: 'gateway-configuration' });
  }
  // An issuer may include its own identity path. Only its trusted origin is reused; the API path is code-owned.
  return `${url.origin}${SHELL_API_PATH}`;
});

/** A local intake setting: the environment, else the gitignored demo secrets file app/.env.demo.local. */
const localSetting = Effect.fn('Crm.partyIntake.localSetting')(
  function* readLocalSetting(name: string) {
    const fromEnvironment = yield* Config.option(Config.Redacted(name));
    if (Option.isSome(fromEnvironment) && Redacted.value(fromEnvironment.value).trim() !== '') {
      return Option.some(Redacted.make(Redacted.value(fromEnvironment.value).trim()));
    }
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = yield* Config.String('ONTOS_DEMO_LOCAL_ENV_FILE').pipe(
      Config.withDefault(path.join(process.cwd(), '../../.env.demo.local')),
    );
    const text = yield* fs.readFileString(file, 'utf-8').pipe(Effect.orElseSucceed(() => ''));
    const line = text.split('\n').find((entry) => entry.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim() ?? '';
    return value === '' ? Option.none<Redacted.Redacted>() : Option.some(Redacted.make(value));
  },
  Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
);

/**
 * Party Registry intake for one company. `identify` returns the registry identity of a client, `Option.none()` when
 * the registry holds a lookalike Party that needs an identity reviewer (the client stays unlinked; the správce sees
 * it on the Klienti page), or fails when the registry or the intake principal is unavailable.
 */
interface PartyIntakeRequest {
  readonly compositionRevision: string;
  /** Forwarded HTTP correlation header and idempotency-key input. */
  readonly correlationId: string;
  readonly delegatedScope?: OperationalScope;
  readonly legalEntityId: string;
}
const crmCreatePayload = (client: IntakeClient, evidenceReference: string, now: string) => {
  const organization = client.kind === 'organization';
  return {
    candidate: {
      ...candidateNameFields(client),
      evidenceRefs: [evidenceReference],
      officialIdentifiers: [
        ...(organization && validIco(client.regNo) ? [{ identifierType: 'ICO', value: client.regNo }] : []),
        ...(organization && client.vatNo !== undefined && /^CZ\d{8,10}$/u.test(client.vatNo.toUpperCase())
          ? [{ identifierType: 'CZ_DIC', value: client.vatNo.toUpperCase() }]
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
  };
};

const makePartyIntake = (scope: PartyIntakeRequest) => {
  const { correlationId } = scope;
  let { compositionRevision } = scope;

  /** One single-use gateway assertion of the intake principal for `audience`. */
  const assertion = Effect.fn('Crm.partyIntake.assertion')(function* issueAssertion(audience: string) {
    if (scope.delegatedScope !== undefined) {
      const issued = yield* acquireDelegatedGatewayContext(
        {
          audience,
          legalEntityScope: 'subject',
          requestCorrelation: correlationId,
          subject: { _tag: 'Assertion', scope: scope.delegatedScope },
        },
        yield* Crypto.Crypto,
      ).pipe(Effect.mapError(registryDown));
      if (issued.compositionRevision !== scope.compositionRevision) {
        return yield* registryDown({ operation: 'intake-release-changed' });
      }
      return {
        authorization: Redacted.make(issued.authorization),
        credential: issued.authorization,
        options: { baseUrl: issued.apiBaseUrl, compositionRevision: issued.compositionRevision },
      };
    }
    const key = yield* localSetting(KEY_VARIABLE);
    if (Option.isNone(key)) {
      return yield* unavailable(
        'Zápis klientů do evidence zákazníků není nastaven (chybí klíč služby CRM); požádejte správce systému',
      );
    }
    const gatewayBase = yield* configuredGatewayBase();
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(`${gatewayBase}/auth/api-key/gateway-context`).pipe(
      HttpClientRequest.setHeaders({ 'x-api-key': Redacted.value(key.value), 'x-correlation-id': correlationId }),
      HttpClientRequest.bodyJsonUnsafe({ audience, compositionRevision, legalEntityId: scope.legalEntityId }),
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
    ({ compositionRevision } = context);
    return {
      authorization: Redacted.make(`Bearer ${Redacted.value(context.token)}`),
      credential: `Bearer ${Redacted.value(context.token)}`,
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
      credential,
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
    const originalScope = scope.delegatedScope;
    if (originalScope === undefined || originalScope.legalEntityId !== scope.legalEntityId) {
      return yield* unavailable('CRM identity intake requires its verified owner-server operation context');
    }
    const evidenceReference = crmClientEvidenceReference(
      { legalEntityId: scope.legalEntityId, tenantId: originalScope.tenantId },
      client.id,
    );
    const createPayload = yield* Schema.decodeUnknownEffect(CreatePartyPayloadSchema)(
      crmCreatePayload(client, evidenceReference, now),
    ).pipe(Effect.mapError(registryDown));
    const sourceScope = scope.delegatedScope;
    if (sourceScope === undefined || sourceScope.legalEntityId !== scope.legalEntityId) {
      return yield* unavailable('CRM identity intake requires its verified owner-server operation context');
    }
    const first = yield* assertion(REGISTRY);
    const created = yield* executeCreateCrmClientPartyWithAuthorization(
      {
        ...createPayload,
        clientId: client.id,
        sourceScope: { legalEntityId: scope.legalEntityId, tenantId: sourceScope.tenantId },
      },
      first.credential,
      correlationId,
      {
        ...first.options,
        idempotencyKey: `${operationKey}:party`,
      },
    ).pipe(Effect.mapError(registryDown));
    if (Schema.is(ActionProposalAcceptedSchema)(created)) {
      return Option.none<VerifiedParty>();
    }
    let partyRef = created.outcome === 'AMBIGUOUS' ? undefined : created.partyRef;
    if (created.outcome === 'AMBIGUOUS') {
      const second = yield* assertion(REGISTRY);
      const detail = yield* executeCrmClientIntakeReviewWithAuthorization(
        {
          caseRef: created.caseRef,
          clientId: client.id,
          decisionRef: created.decisionRef,
          sourceScope: { legalEntityId: scope.legalEntityId, tenantId: sourceScope.tenantId },
        },
        second.credential,
        correlationId,
        second.options,
      ).pipe(Effect.mapError(registryDown));
      if (detail.outcome === 'review') {
        return Option.none<VerifiedParty>();
      }
      const third = yield* assertion(REGISTRY);
      const resolved = yield* resolveDuplicateCandidateCreateWithAuthorization(
        yield* Schema.decodeUnknownEffect(ResolveDuplicateCandidateCreatePayloadSchema)({
          caseRef: created.caseRef,
          expectedRevision: detail.revision,
          reason:
            'New CRM client; the candidate Parties share only a lookalike name or contact, no official identifier',
        }).pipe(Effect.mapError(registryDown)),
        third.credential,
        { ...third.options, correlationId, idempotencyKey: `${operationKey}:resolve-create` },
      ).pipe(Effect.mapError(registryDown));
      if (Schema.is(ActionProposalAcceptedSchema)(resolved)) {
        return Option.none<VerifiedParty>();
      }
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
    const onboarded = yield* counterpartyCustomerOnboardWithAuthorization(onboardPayload, fourth.credential, {
      ...fourth.options,
      correlationId,
      idempotencyKey: `${operationKey}:onboard`,
    }).pipe(Effect.mapError(registryDown));
    if (Schema.is(ActionProposalAcceptedSchema)(onboarded)) {
      return Option.none<VerifiedParty>();
    }
    if (
      onboarded.legalEntityRef.resourceId !== scope.legalEntityId ||
      (scope.delegatedScope !== undefined &&
        (onboarded.partyRef.tenantId !== scope.delegatedScope.tenantId ||
          onboarded.counterpartyRef.tenantId !== scope.delegatedScope.tenantId)) ||
      onboarded.partyRef.resourceId !== partyRef.resourceId ||
      onboarded.roleType !== 'CUSTOMER'
    ) {
      return yield* registryDown({ operation: 'intake-counterparty-scope' });
    }
    const contactPoints = contactPointsOf(client);
    // Keep the public Action calls ordered. Malformed legacy contacts must not block the identity link.
    const addContact = Effect.fn('Crm.partyIntake.addContact')(
      function* addContact(contactPoint: ReturnType<typeof contactPointsOf>[number], index: number) {
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
        });
        const { credential, options } = yield* assertion(REGISTRY);
        yield* addContactPointWithAuthorization(payload, credential, {
          ...options,
          correlationId,
          idempotencyKey: `${operationKey}:contact:${index}`,
        });
      },
      (effect) => Effect.ignore(effect),
    );
    yield* Effect.forEach(contactPoints, addContact, { concurrency: 1, discard: true });
    return Option.some(
      yield* Schema.decodeEffect(VerifiedPartySchema)({
        counterpartyId: onboarded.counterpartyRef.resourceId,
        displayName: client.name,
        partyId: partyRef.resourceId,
      }).pipe(Effect.mapError(registryDown)),
    );
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
      const party: VerifiedParty = { counterpartyId: existing.counterpartyId, partyId: existing.partyId };
      return Option.some<VerifiedParty>(
        Option.isNone(existing.displayName) ? party : { ...party, displayName: existing.displayName.value },
      );
    }
    return yield* createCustomer(client, operationKey);
  });

  /** A purpose-only owner Read returns ids and link observations, never the general CRM document. */
  const crmRecords = Effect.fn('Crm.partyIntake.pending')(function* pending(clientIds?: readonly string[]) {
    const crm = yield* assertion(CRM);
    return yield* executePendingClientIntakeWithAuthorization(
      clientIds === undefined
        ? {}
        : {
            clientIds: yield* Schema.decodeUnknownEffect(Schema.Array(EntityIdSchema))(clientIds).pipe(
              Effect.mapError(registryDown),
            ),
          },
      crm.credential,
      correlationId,
      crm.options,
    ).pipe(Effect.timeout('20 seconds'), Effect.mapError(registryDown));
  });

  const reconcile = Effect.fn('Crm.partyIntake.reconcile')(function* reconcile(clientIds?: readonly string[]) {
    const before = yield* crmRecords(clientIds);
    const targets = before.items.filter((client) => !client.linked).slice(0, BATCH);
    const outcome = yield* Effect.reduce(
      targets,
      () => ({ failed: 0, linked: 0, review: 0, revision: before.revision }),
      Effect.fn('Crm.partyIntake.reconcileOne')(function* reconcileOne(state, client) {
        const crm = yield* assertion(CRM);
        const observed = yield* executeIntakeClientPartyWithAuthorization(
          { clientId: client.id, expectedRevision: state.revision },
          crm.credential,
          correlationId,
          { ...crm.options, idempotencyKey: `crm-intake:${correlationId}:${client.id}`.slice(0, 200) },
        ).pipe(Effect.timeout('30 seconds'), Effect.mapError(registryDown), Effect.result);
        if (Result.isFailure(observed)) {
          return { ...state, failed: state.failed + 1 };
        }
        const response = observed.success;
        return {
          ...state,
          linked: state.linked + (response.status === 'linked' ? 1 : 0),
          review: state.review + (response.status === 'review' ? 1 : 0),
          revision: response.revision,
        };
      }),
    );
    const after = yield* crmRecords(clientIds).pipe(
      Effect.filterOrFail(
        (current) => current.revision >= before.revision + outcome.linked,
        () => unavailable('Committed client identity links could not be observed in current owner state'),
      ),
    );
    const linked = targets.filter((target) => after.items.some((item) => item.id === target.id && item.linked)).length;
    const remaining = after.items.filter((item) => !item.linked).length;
    const failed = Math.max(outcome.failed, targets.length - linked - outcome.review);
    const complete = remaining === 0 && failed === 0 && outcome.review === 0;
    let status: ClientPartySync['status'] = 'partial';
    if (complete) {
      status = linked === 0 ? 'unchanged' : 'complete';
    }
    return {
      failed,
      linked,
      remaining,
      review: outcome.review,
      status,
    } satisfies ClientPartySync;
  });

  return { identify, reconcile };
};

export class PartyIntake extends Context.Service<PartyIntake, { readonly forRequest: typeof makePartyIntake }>()(
  '@app/crm/services/party-intake/PartyIntake',
) {}
export const PartyIntakeLive = Layer.succeed(PartyIntake, { forRequest: makePartyIntake });
