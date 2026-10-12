import { randomUUID } from 'node:crypto';

import { shellComposition } from '@app/shell-super-app/api/client';
import { ShellAuthenticationApi } from '@app/shell-super-app/api';
import { issueGatewayContext, ReferenceGatewayCredentialsSchema } from '@app/shared-contracts';
import {
  executeCounterpartyReadWithAuthorization as readCounterparty,
  loadCounterpartiesClientWithAuthorization as searchCounterparties,
} from '@app/party-registry/api/client';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { executeApplyCommandWithAuthorization as executeAgreementCommand } from '@app/siampark-agreements/api/client';
import { executeRecordsWithAuthorization as readAgreements } from '@app/siampark-agreements/clients/records';
import { ApplyCommandPayloadSchema as AgreementPayloadSchema } from '@app/siampark-agreements/contracts/apply-command';
import type { AgreementsCommand } from '@app/siampark-agreements/contracts/apply-command';
import { ContractSchema, DocumentSchema } from '@app/siampark-agreements/contracts/records';
import { executeApplyCommandWithAuthorization as executeFinanceCommand } from '@app/siampark-billing-finance/clients/apply-command';
import { executeRecordsWithAuthorization as readInvoices } from '@app/siampark-billing-finance/clients/records';
import { ApplyCommandPayloadSchema as FinancePayloadSchema } from '@app/siampark-billing-finance/contracts/apply-command';
import type { FinanceCommand } from '@app/siampark-billing-finance/contracts/apply-command';
import { RecordsForbiddenProblemSchema as InvoiceForbiddenSchema } from '@app/siampark-billing-finance/contracts/records';
import { executeApplyCommandWithAuthorization as executeOccupancyCommand } from '@app/siampark-occupancy/api/client';
import { executeRecordsWithAuthorization as readOccupancies } from '@app/siampark-occupancy/clients/records';
import { ApplyCommandPayloadSchema as OccupancyPayloadSchema } from '@app/siampark-occupancy/contracts/apply-command';
import type { OccupancyCommand } from '@app/siampark-occupancy/contracts/apply-command';
import { OccupancySchema } from '@app/siampark-occupancy/contracts/records';
import { executeRecordsWithAuthorization as readProperties } from '@app/siampark-property/clients/records';
import { executeApplyCommandWithAuthorization as executeActivityCommand } from '@app/siampark-relationships/clients/apply-command';
import { executeRecordsWithAuthorization as readActivities } from '@app/siampark-relationships/clients/records';
import { ApplyCommandPayloadSchema as ActivityPayloadSchema } from '@app/siampark-relationships/contracts/apply-command';
import { executeApplyCommandWithAuthorization } from '@app/siampark-work/clients/apply-command';
import { executeRecordsWithAuthorization as readTasks } from '@app/siampark-work/clients/records';
import { ApplyCommandPayloadSchema } from '@app/siampark-work/contracts/apply-command';
import { RecordsForbiddenProblemSchema as TaskForbiddenSchema } from '@app/siampark-work/contracts/records';
import { NodeHttpClient } from '@effect/platform-node';
import { Effect, Predicate, Redacted, Result, Schema } from 'effect';
import { expect, layer } from 'effect-rstest';
import { Cookies, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';

// The live development fixture is reset by the operator, never by this test.
// These stable resource IDs belong to scripts/siampark/fixtures.mts.
const shellOrigin = 'http://localhost:3020';
const shellApiBaseUrl = `${shellOrigin}/shell-super-app-api`;
const assignedTaskId = '76000000-0000-4000-8000-000000000035';
const unrelatedTaskId = '76000000-0000-4000-8000-000000000032';
const assignedActivityId = '76000000-0000-4000-8000-000000000038';
const assignedCounterpartyId = '76000000-0000-4000-8000-000000000016';
const invoiceId = '76000000-0000-4000-8000-000000000027';
const overdueInvoiceId = '76000000-0000-4000-8000-000000000028';
const goldenCounterpartyId = '76000000-0000-4000-8000-000000000017';
const expiringContractId = '76000000-0000-4000-8000-000000000024';
const referenceDate = '2026-10-05';
const referenceInstant = '2026-10-05T10:00:00.000Z';

class LiveDemoPrerequisiteUnavailable extends Schema.TaggedError<LiveDemoPrerequisiteUnavailable>()(
  'LiveDemoPrerequisiteUnavailable',
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const signIn = Effect.fn('SiamparkLiveHttp.signIn')(function* signInDemoAccount(
  email: 'operations@siampark.demo' | 'external@siampark.demo' | 'management@siampark.demo',
) {
  const client = yield* HttpApiClient.make(ShellAuthenticationApi, {
    baseUrl: shellApiBaseUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader('origin', shellOrigin)),
  });
  const [, response] = yield* client.authentication.signIn({
    payload: { email, password: Redacted.make('password1234') },
    responseMode: 'decoded-and-response',
  });
  expect(response.status).toBe(200);
  expect(Cookies.isEmpty(response.cookies)).toBe(false);
  const cookie = Cookies.toCookieHeader(response.cookies);
  const composition = yield* shellComposition({}, { baseUrl: shellApiBaseUrl, cookie });
  if (composition.state !== 'available') {
    return yield* new LiveDemoPrerequisiteUnavailable({ reason: 'The live demo composition is unavailable.' });
  }
  return { compositionRevision: composition.compositionRevision, cookie };
});

const authorize = Effect.fn('SiamparkLiveHttp.authorize')(function* authorizeDemoOwner(
  session: { readonly compositionRevision: string; readonly cookie: string },
  audience: string,
) {
  const context = yield* issueGatewayContext(
    { audience, compositionRevision: session.compositionRevision },
    { baseUrl: shellApiBaseUrl, cookie: session.cookie },
  );
  expect(context.compositionRevision).toBe(session.compositionRevision);
  return {
    credential: `Bearer ${context.token}`,
    options: {
      baseUrl: new URL(context.apiBaseUrl, shellOrigin),
      compositionRevision: context.compositionRevision,
    },
  };
});

const correlation = (): string => randomUUID();
type LiveHttpFailure = Effect.Error<
  ReturnType<
    | typeof signIn
    | typeof authorize
    | typeof readTasks
    | typeof readActivities
    | typeof readInvoices
    | typeof executeApplyCommandWithAuthorization
    | typeof executeFinanceCommand
    | typeof executeAgreementCommand
    | typeof executeOccupancyCommand
    | typeof executeActivityCommand
    | typeof readAgreements
    | typeof readOccupancies
    | typeof readProperties
    | typeof readCounterparty
    | typeof searchCounterparties
  >
>;
// Native transport errors carry request headers; failure output must never expose assertions or cookies.
const safeTransportFailure = (failure: LiveHttpFailure) =>
  new LiveDemoPrerequisiteUnavailable({
    reason:
      Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag)
        ? failure._tag
        : 'The live HTTP transport failed.',
  });

type LiveSession = Effect.Success<ReturnType<typeof signIn>>;
// The public SDK wire schema is the native-client equivalent of its browser
// makeReferenceGatewayCredentials helper, whose revision comes from the DOM.
const referenceCredentials = Effect.fn('SiamparkLiveHttp.referenceCredentials')(function* providerCredentials(
  session: LiveSession,
  audiences: readonly string[],
) {
  const credentials = yield* Effect.forEach(
    audiences,
    (audience) =>
      authorize(session, audience).pipe(
        Effect.map(({ credential }) => ({ audience, authorization: Redacted.make(credential) })),
      ),
    { concurrency: 1 },
  );
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ReferenceGatewayCredentialsSchema))(credentials);
  return Redacted.make(encoded);
});

const readLiveAgreements = Effect.fn('SiamparkLiveHttp.readAgreements')(function* agreementsRead(session: LiveSession) {
  const grant = yield* authorize(session, 'siampark-agreements');
  return yield* readAgreements({}, grant.credential, correlation(), grant.options);
});
const readLiveOccupancies = Effect.fn('SiamparkLiveHttp.readOccupancies')(function* occupancyRead(
  session: LiveSession,
) {
  const grant = yield* authorize(session, 'siampark-occupancy');
  return yield* readOccupancies({}, grant.credential, correlation(), grant.options);
});
const readLiveFinance = Effect.fn('SiamparkLiveHttp.readFinance')(function* financeRead(session: LiveSession) {
  const grant = yield* authorize(session, 'siampark-billing-finance');
  return yield* readInvoices({}, grant.credential, correlation(), grant.options);
});

const applyAgreementCommand = Effect.fn('SiamparkLiveHttp.applyAgreementCommand')(function* agreementAction(
  session: LiveSession,
  expectedRevision: number,
  command: AgreementsCommand,
) {
  const payload = yield* Schema.decodeEffect(AgreementPayloadSchema)({ command, expectedRevision });
  const providers = yield* referenceCredentials(session, [
    'party-registry',
    'siampark-occupancy',
    'siampark-property',
    'siampark-property',
  ]);
  const grant = yield* authorize(session, 'siampark-agreements');
  return yield* executeAgreementCommand(payload, grant.credential, correlation(), {
    ...grant.options,
    idempotencyKey: correlation(),
    referenceCredentials: providers,
  });
});
const applyOccupancyCommand = Effect.fn('SiamparkLiveHttp.applyOccupancyCommand')(function* occupancyAction(
  session: LiveSession,
  expectedRevision: number,
  command: OccupancyCommand,
) {
  const payload = yield* Schema.decodeEffect(OccupancyPayloadSchema)({ command, expectedRevision });
  const providers = yield* referenceCredentials(session, [
    'siampark-property',
    'siampark-property',
    'party-registry',
    'siampark-agreements',
  ]);
  const grant = yield* authorize(session, 'siampark-occupancy');
  return yield* executeOccupancyCommand(payload, grant.credential, correlation(), {
    ...grant.options,
    idempotencyKey: correlation(),
    referenceCredentials: providers,
  });
});

const applyFinanceCommand = Effect.fn('SiamparkLiveHttp.applyFinanceCommand')(function* applyLiveFinanceCommand(
  session: { readonly compositionRevision: string; readonly cookie: string },
  expectedRevision: number,
  command: FinanceCommand,
  providerAudiences: readonly string[] = [],
) {
  const payload = yield* Schema.decodeEffect(FinancePayloadSchema)({ command, expectedRevision });
  const grant = yield* authorize(session, 'siampark-billing-finance');
  const providers = yield* referenceCredentials(session, providerAudiences);
  return yield* executeFinanceCommand(payload, grant.credential, correlation(), {
    ...grant.options,
    idempotencyKey: correlation(),
    referenceCredentials: providers,
  });
});

const prepareGoldenLease = Effect.fn('SiamparkLiveHttp.prepareGoldenLease')(function* goldenLeaseBaseline(
  session: LiveSession,
) {
  const propertyGrant = yield* authorize(session, 'siampark-property');
  const property = yield* readProperties({}, propertyGrant.credential, correlation(), propertyGrant.options);
  const occupancies = yield* readLiveOccupancies(session);
  const agreements = yield* readLiveAgreements(session);
  const finance = yield* readLiveFinance(session);
  const unit = property.units.find((item) => item.code === 'A101');
  const [occupancyTemplate] = occupancies.occupancies;
  const [contractTemplate] = agreements.contracts;
  const [documentTemplate] = agreements.documents;
  if (
    unit === undefined ||
    occupancyTemplate === undefined ||
    contractTemplate === undefined ||
    documentTemplate === undefined
  ) {
    return yield* new LiveDemoPrerequisiteUnavailable({ reason: 'The reset golden lease fixture is incomplete.' });
  }
  expect(occupancies.occupancies.filter((item) => item.unitRef.resourceId === unit.unitRef.resourceId)).toEqual([]);
  expect(finance.state.invoices.filter((item) => item.unitRef?.resourceId === unit.unitRef.resourceId)).toEqual([]);
  expect(finance.canWrite).toBe(true);
  const searchGrant = yield* authorize(session, 'party-registry');
  const results = yield* searchCounterparties(
    { query: 'Eva', role: 'CUSTOMER' },
    searchGrant.credential,
    correlation(),
    searchGrant.options,
  );
  const selected = results.find((item) => item.ref.resourceId === goldenCounterpartyId);
  if (selected === undefined) {
    return yield* new LiveDemoPrerequisiteUnavailable({ reason: 'The public Eva customer search did not find A101.' });
  }
  expect(selected.currentRoles).toContain('CUSTOMER');
  expect(selected.party.archived).toBe(false);
  const partyGrant = yield* authorize(session, 'party-registry');
  const customer = yield* readCounterparty(
    { counterpartyRef: selected.ref },
    partyGrant.credential,
    correlation(),
    partyGrant.options,
  );
  expect(customer.currentRoles.some((role) => role.roleType === 'CUSTOMER' && role.state === 'ACTIVE')).toBe(true);
  expect(customer.party.archived).toBe(false);
  const occupancy = yield* Schema.decodeEffect(OccupancySchema)({
    contractRef: null,
    customerCounterpartyRef: customer.counterpartyRef,
    endDate: '2027-10-05',
    externalBookingCorrelation: null,
    guestPartyRef: null,
    kind: 'LONG_TERM_LEASE',
    note: 'Live public Action acceptance',
    occupancyRef: { ...occupancyTemplate.occupancyRef, resourceId: correlation() },
    peopleCount: 1,
    startDate: referenceDate,
    state: 'DRAFT',
    unitRef: unit.unitRef,
  });
  const contract = yield* Schema.decodeEffect(ContractSchema)({
    contractRef: { ...contractTemplate.contractRef, resourceId: correlation() },
    counterpartyRef: customer.counterpartyRef,
    endDate: occupancy.endDate,
    kind: 'LEASE',
    lifecycleState: 'DRAFT',
    note: 'Live public Action acceptance',
    occupancyRef: occupancy.occupancyRef,
    propertyRef: unit.propertyRef,
    renewalNoticeDate: null,
    signatureState: 'NOT_SENT',
    startDate: occupancy.startDate,
    supersedesContractRef: null,
    unitRef: unit.unitRef,
  });
  const document = yield* Schema.decodeEffect(DocumentSchema)({
    contractRef: contract.contractRef,
    createdAt: referenceInstant,
    documentRef: { ...documentTemplate.documentRef, resourceId: correlation() },
    fileName: 'live-a101-demo.pdf',
    kind: 'LEASE',
    lifecycleState: 'FINAL',
    signedDocumentReference: `DEMO:live-signed:${contract.contractRef.resourceId}`,
    title: 'Simulated signed A101 lease',
    updatedAt: referenceInstant,
  });
  return { agreements, contract, customer, document, finance, occupancies, occupancy, unit };
});

const executeGoldenSignature = Effect.fn('SiamparkLiveHttp.executeGoldenSignature')(function* signedGoldenContract(
  session: LiveSession,
  prepared: Effect.Success<ReturnType<typeof prepareGoldenLease>>,
) {
  const { contract, document } = prepared;
  const created = yield* applyAgreementCommand(session, prepared.agreements.revision, {
    _tag: 'CreateContract',
    record: contract,
  });
  const sent = yield* applyAgreementCommand(session, created.revision, {
    _tag: 'SendSignature',
    contractRef: contract.contractRef,
    signerContact: 'golden-a101@siampark.demo',
  });
  const pending = yield* readLiveAgreements(session);
  expect(
    pending.contracts.find((item) => item.contractRef.resourceId === contract.contractRef.resourceId)?.signatureState,
  ).toBe('SENT');
  expect(
    pending.signatureObservations.find((item) => item.contractRef.resourceId === contract.contractRef.resourceId),
  ).toMatchObject({
    mode: 'SIMULATED',
    signer: { counterpartyRef: prepared.customer.counterpartyRef, partyRef: prepared.customer.party.canonicalPartyRef },
    state: 'SENT',
  });
  const signed = yield* applyAgreementCommand(session, sent.revision, {
    _tag: 'ObserveSignature',
    contractRef: contract.contractRef,
    document,
    outcome: 'SIGNED',
  });
  const active = yield* applyAgreementCommand(session, signed.revision, {
    _tag: 'ActivateContract',
    contractRef: contract.contractRef,
  });
  const after = yield* readLiveAgreements(session);
  expect(after.revision).toBe(active.revision);
  expect(after.contracts).toHaveLength(prepared.agreements.contracts.length + 1);
  expect(after.documents).toHaveLength(prepared.agreements.documents.length + 1);
  expect(after.contracts.find((item) => item.contractRef.resourceId === contract.contractRef.resourceId)).toMatchObject(
    { lifecycleState: 'ACTIVE', signatureState: 'SIGNED' },
  );
  expect(after.documents.find((item) => item.documentRef.resourceId === document.documentRef.resourceId)).toMatchObject(
    {
      contractRef: contract.contractRef,
      lifecycleState: 'FINAL',
      signedDocumentReference: document.signedDocumentReference,
    },
  );
  return active;
});

const executeGoldenInvoice = Effect.fn('SiamparkLiveHttp.executeGoldenInvoice')(function* confirmedGoldenInvoice(
  session: LiveSession,
  prepared: Effect.Success<ReturnType<typeof prepareGoldenLease>>,
) {
  const payload = yield* Schema.decodeEffect(FinancePayloadSchema)({
    command: {
      _tag: 'CreateInvoiceDraft',
      contractRef: prepared.contract.contractRef,
      counterpartyRef: prepared.customer.counterpartyRef,
      currency: 'CZK',
      direction: 'OUTGOING',
      documentNumber: `DEMO-LIVE-A101-${correlation()}`,
      dueDate: '2026-10-15',
      issueDate: referenceDate,
      occupancyRef: prepared.occupancy.occupancyRef,
      propertyRef: prepared.unit.propertyRef,
      totalMinor: 1_500_000,
      unitRef: prepared.unit.unitRef,
    },
    expectedRevision: prepared.finance.revision,
  });
  const providers = [
    'party-registry',
    'siampark-property',
    'siampark-property',
    'siampark-occupancy',
    'siampark-agreements',
  ];
  const draft = yield* applyFinanceCommand(session, prepared.finance.revision, payload.command, providers);
  const confirmed = yield* applyFinanceCommand(
    session,
    draft.revision,
    { _tag: 'ConfirmInvoice', invoiceRef: draft.invoice.ref },
    providers,
  );
  expect(confirmed.invoice).toMatchObject({
    accountingSyncState: 'NOT_SYNCED',
    businessState: 'CONFIRMED',
    paymentState: 'UNPAID',
  });
  const pending = yield* applyFinanceCommand(session, confirmed.revision, {
    _tag: 'RequestAccountingSync',
    invoiceRef: draft.invoice.ref,
  });
  expect(pending.invoice.accountingSyncState).toBe('PENDING');
  const receipt = `DEMO:live-golden-receipt:${correlation()}`;
  const synced = yield* applyFinanceCommand(session, pending.revision, {
    _tag: 'ApplyAccountingObservation',
    correlation: draft.invoice.accountingCorrelation,
    invoiceRef: draft.invoice.ref,
    receipt,
    resultId: `live-golden-accounting:${correlation()}`,
    status: 'SUCCESS',
  });
  const after = yield* readLiveFinance(session);
  expect(after.revision).toBe(synced.revision);
  expect(after.state.invoices).toHaveLength(prepared.finance.state.invoices.length + 1);
  expect(after.state.invoices.find((item) => item.ref.resourceId === draft.invoice.ref.resourceId)).toMatchObject({
    accountingSyncState: 'SYNCED',
    externalAccountingReference: receipt,
    totalMinor: 1_500_000,
    unitRef: prepared.unit.unitRef,
  });
  expect(after.indicators.revenueMinor).toBe(prepared.finance.indicators.revenueMinor + 1_500_000);
  return synced;
});

layer(NodeHttpClient.layerNodeHttp, { excludeTestServices: true })('Siampark live HTTP acceptance', (it) => {
  it.effect('live Management reads Finance and simulated email evidence with read-only server capabilities', () =>
    Effect.gen(function* managementReadOnlyFinance() {
      const session = yield* signIn('management@siampark.demo');
      const finance = yield* readLiveFinance(session);
      expect(finance.canWrite).toBe(false);
      expect(finance.state.invoices.length).toBeGreaterThanOrEqual(4);
      expect(finance.state.invoices.some((item) => item.ref.resourceId === overdueInvoiceId)).toBe(true);
      const relationships = yield* authorize(session, 'siampark-relationships');
      const activities = yield* readActivities({}, relationships.credential, correlation(), relationships.options);
      expect(activities.canWrite).toBe(false);
      expect(activities.emailObservations).toHaveLength(1);
      expect(activities.emailObservations).toEqual([
        expect.objectContaining({
          integrationKind: 'EMAIL',
          mode: 'SIMULATED',
          providerLabel: 'DEMO',
          status: 'SUCCESS',
        }),
      ]);
      expect(
        activities.items.some(
          (item) => item.ref.resourceId === activities.emailObservations[0]?.ownerResourceRef.resourceId,
        ),
      ).toBe(true);
      return finance.revision;
    }).pipe(Effect.mapError(safeTransportFailure)),
  );

  it.effect(
    'live Operations completes the A101 lease through owning occupancy, signature and invoice Actions',
    () =>
      Effect.gen(function* operationsGoldenLease() {
        const session = yield* signIn('operations@siampark.demo');
        const prepared = yield* prepareGoldenLease(session);
        const initialDraft = yield* Schema.decodeEffect(OccupancySchema)({
          ...prepared.occupancy,
          endDate: '2027-10-06',
          startDate: '2026-10-06',
        });
        const created = yield* applyOccupancyCommand(session, prepared.occupancies.revision, {
          _tag: 'CreateDraft',
          record: initialDraft,
        });
        const updated = yield* applyOccupancyCommand(session, created.revision, {
          _tag: 'UpdateDraft',
          endDate: prepared.occupancy.endDate,
          occupancyRef: prepared.occupancy.occupancyRef,
          startDate: prepared.occupancy.startDate,
        });
        const draftRead = yield* readLiveOccupancies(session);
        expect(
          draftRead.occupancies.find((item) => item.occupancyRef.resourceId === created.resourceRef?.resourceId),
        ).toMatchObject({
          endDate: prepared.occupancy.endDate,
          occupancyRef: prepared.occupancy.occupancyRef,
          startDate: prepared.occupancy.startDate,
          state: 'DRAFT',
        });
        const confirmed = yield* applyOccupancyCommand(session, updated.revision, {
          _tag: 'Confirm',
          occupancyRef: prepared.occupancy.occupancyRef,
        });
        yield* executeGoldenSignature(session, prepared);
        const activated = yield* applyOccupancyCommand(session, confirmed.revision, {
          _tag: 'Activate',
          contractRef: prepared.contract.contractRef,
          occupancyRef: prepared.occupancy.occupancyRef,
        });
        const after = yield* readLiveOccupancies(session);
        expect(after.revision).toBe(activated.revision);
        expect(after.occupancies).toHaveLength(prepared.occupancies.occupancies.length + 1);
        expect(
          after.occupancies.find((item) => item.occupancyRef.resourceId === prepared.occupancy.occupancyRef.resourceId),
        ).toMatchObject({
          contractRef: prepared.contract.contractRef,
          state: 'ACTIVE',
          unitRef: prepared.unit.unitRef,
        });
        expect(after.occupancies.filter((item) => item.state === 'ACTIVE')).toHaveLength(
          prepared.occupancies.occupancies.filter((item) => item.state === 'ACTIVE').length + 1,
        );
        yield* executeGoldenInvoice(session, prepared);
      }).pipe(Effect.mapError(safeTransportFailure)),
    120_000,
  );

  it.effect('live Operations creates a B201 successor draft and resolves only renewal attention', () =>
    Effect.gen(function* operationsRenewalDraft() {
      const session = yield* signIn('operations@siampark.demo');
      const before = yield* readLiveAgreements(session);
      const old = before.contracts.find((item) => item.contractRef.resourceId === expiringContractId);
      if (old === undefined || old.endDate === null || old.hasSuccessorDraft) {
        return yield* new LiveDemoPrerequisiteUnavailable({
          reason: 'B201 requires the expiring contract without a successor fixture.',
        });
      }
      expect(old.expiringSoon).toBe(true);
      const successor = yield* Schema.decodeEffect(ContractSchema)({
        ...old,
        contractRef: { ...old.contractRef, resourceId: correlation() },
        endDate: '2027-10-25',
        lifecycleState: 'DRAFT',
        renewalNoticeDate: null,
        signatureState: 'NOT_SENT',
        startDate: old.endDate,
        supersedesContractRef: old.contractRef,
      });
      const created = yield* applyAgreementCommand(session, before.revision, {
        _tag: 'RenewContract',
        contractRef: old.contractRef,
        successor,
      });
      const after = yield* readLiveAgreements(session);
      expect(after.revision).toBe(created.revision);
      expect(after.contracts).toHaveLength(before.contracts.length + 1);
      expect(after.contracts.find((item) => item.contractRef.resourceId === old.contractRef.resourceId)).toMatchObject({
        expiringSoon: true,
        hasSuccessorDraft: true,
        lifecycleState: 'ACTIVE',
      });
      expect(
        after.contracts.find((item) => item.contractRef.resourceId === successor.contractRef.resourceId),
      ).toMatchObject({ lifecycleState: 'DRAFT', signatureState: 'NOT_SENT', supersedesContractRef: old.contractRef });
      expect(after.contracts.filter((item) => item.expiringSoon)).toHaveLength(
        before.contracts.filter((item) => item.expiringSoon).length,
      );
      expect(after.contracts.filter((item) => item.expiringSoon && !item.hasSuccessorDraft)).toHaveLength(
        before.contracts.filter((item) => item.expiringSoon && !item.hasSuccessorDraft).length - 1,
      );
      return after.revision;
    }).pipe(Effect.mapError(safeTransportFailure)),
  );

  it.effect('live Operations records a canonical relationship Activity linked to one real Work Task', () =>
    Effect.gen(function* operationsRelationshipFollowUp() {
      const session = yield* signIn('operations@siampark.demo');
      const relationshipGrant = yield* authorize(session, 'siampark-relationships');
      const before = yield* readActivities({}, relationshipGrant.credential, correlation(), relationshipGrant.options);
      const workGrant = yield* authorize(session, 'siampark-work');
      const workBefore = yield* readTasks({}, workGrant.credential, correlation(), workGrant.options);
      const agreements = yield* readLiveAgreements(session);
      const contract = agreements.contracts.find((item) => item.contractRef.resourceId === expiringContractId);
      if (contract === undefined || contract.unitRef === null) {
        return yield* new LiveDemoPrerequisiteUnavailable({ reason: 'The B201 follow-up fixture is incomplete.' });
      }
      const taskPayload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
        command: {
          _tag: 'CreateTask',
          contextRefs: [contract.unitRef],
          dueDate: '2026-10-10',
          ownerPrincipalRef: workBefore.actorPrincipalRef,
          priority: 'NORMAL',
          title: `Live B201 follow-up ${correlation()}`,
        },
        expectedRevision: workBefore.revision,
      });
      const taskProviders = yield* referenceCredentials(session, ['siampark-property']);
      const taskGrant = yield* authorize(session, 'siampark-work');
      const task = yield* executeApplyCommandWithAuthorization(taskPayload, taskGrant.credential, correlation(), {
        ...taskGrant.options,
        idempotencyKey: correlation(),
        referenceCredentials: taskProviders,
      });
      const activityPayload = yield* Schema.decodeEffect(ActivityPayloadSchema)({
        command: {
          _tag: 'RecordActivity',
          counterpartyRef: contract.counterpartyRef,
          followUpTaskRef: task.task.ref,
          kind: 'CALL',
          occurredAt: referenceInstant,
          ownerPrincipalRef: before.actorPrincipalRef,
          summary: `Live B201 relationship follow-up ${correlation()}`,
        },
        expectedRevision: before.revision,
      });
      const activityProviders = yield* referenceCredentials(session, ['party-registry', 'siampark-work']);
      const activityGrant = yield* authorize(session, 'siampark-relationships');
      const recorded = yield* executeActivityCommand(activityPayload, activityGrant.credential, correlation(), {
        ...activityGrant.options,
        idempotencyKey: correlation(),
        referenceCredentials: activityProviders,
      });
      const finalGrant = yield* authorize(session, 'siampark-relationships');
      const after = yield* readActivities(
        { counterpartyId: contract.counterpartyRef.resourceId },
        finalGrant.credential,
        correlation(),
        finalGrant.options,
      );
      expect(after.revision).toBe(recorded.revision);
      expect(after.items.find((item) => item.ref.resourceId === recorded.activity.ref.resourceId)).toMatchObject({
        counterpartyRef: contract.counterpartyRef,
        followUpTaskRef: task.task.ref,
        kind: 'CALL',
        ownerPrincipalRef: before.actorPrincipalRef,
      });
      const taskReadGrant = yield* authorize(session, 'siampark-work');
      const persistedTask = yield* readTasks(
        { resourceId: task.task.ref.resourceId },
        taskReadGrant.credential,
        correlation(),
        taskReadGrant.options,
      );
      expect(persistedTask.revision).toBe(task.revision);
      expect(persistedTask.items).toEqual([task.task]);
      return after.revision;
    }).pipe(Effect.mapError(safeTransportFailure)),
  );

  it.effect('live Operations applies payment independently and retries accounting on the existing Invoice', () =>
    Effect.gen(function* operationsPaymentAndAccounting() {
      const session = yield* signIn('operations@siampark.demo');
      const initialGrant = yield* authorize(session, 'siampark-billing-finance');
      const before = yield* readInvoices({}, initialGrant.credential, correlation(), initialGrant.options);
      const invoice = before.state.invoices.find((item) => item.ref.resourceId === overdueInvoiceId);
      if (invoice === undefined || invoice.accountingSyncState !== 'FAILED') {
        return yield* new LiveDemoPrerequisiteUnavailable({ reason: 'B201 requires the FAILED accounting fixture.' });
      }
      const paymentResultId = `live-payment:${correlation()}`;
      const paymentCommand: FinanceCommand = {
        _tag: 'ApplyPaymentObservation',
        confirmedPaidMinor: invoice.totalMinor,
        correlation: `payment:${overdueInvoiceId}`,
        currency: 'CZK',
        invoiceRef: invoice.ref,
        resultId: paymentResultId,
      };
      const payment = yield* applyFinanceCommand(session, before.revision, paymentCommand);
      expect(payment.changed).toBe(true);
      expect(payment.revision).toBe(before.revision + 1);
      expect(payment.invoice).toMatchObject({
        accountingSyncState: 'FAILED',
        paidMinor: invoice.totalMinor,
        paymentState: 'PAID',
      });
      const replay = yield* applyFinanceCommand(session, payment.revision, paymentCommand);
      expect(replay.changed).toBe(false);
      expect(replay.revision).toBe(payment.revision);
      const retry = yield* applyFinanceCommand(session, replay.revision, {
        _tag: 'RetryAccountingSync',
        invoiceRef: invoice.ref,
      });
      expect(retry.revision).toBe(payment.revision + 1);
      expect(retry.invoice).toMatchObject({
        accountingCorrelation: invoice.accountingCorrelation,
        accountingSyncState: 'PENDING',
        paymentState: 'PAID',
      });
      const accountingResultId = `live-accounting:${correlation()}`;
      const receipt = `DEMO:live-receipt:${correlation()}`;
      const accountingCommand: FinanceCommand = {
        _tag: 'ApplyAccountingObservation',
        correlation: invoice.accountingCorrelation,
        invoiceRef: invoice.ref,
        receipt,
        resultId: accountingResultId,
        status: 'SUCCESS',
      };
      const completed = yield* applyFinanceCommand(session, retry.revision, accountingCommand);
      expect(completed.revision).toBe(retry.revision + 1);
      expect(completed.invoice).toMatchObject({
        accountingCorrelation: invoice.accountingCorrelation,
        accountingSyncState: 'SYNCED',
        externalAccountingReference: receipt,
        paymentState: 'PAID',
      });
      const accountingReplay = yield* applyFinanceCommand(session, completed.revision, accountingCommand);
      expect(accountingReplay.changed).toBe(false);
      expect(accountingReplay.revision).toBe(completed.revision);
      const finalGrant = yield* authorize(session, 'siampark-billing-finance');
      const after = yield* readInvoices({}, finalGrant.credential, correlation(), finalGrant.options);
      expect(after.revision).toBe(completed.revision);
      expect(after.state.invoices).toHaveLength(before.state.invoices.length);
      expect(after.state.invoices.filter((item) => item.ref.resourceId !== overdueInvoiceId)).toEqual(
        before.state.invoices.filter((item) => item.ref.resourceId !== overdueInvoiceId),
      );
      expect(after.state.paymentObservations.filter((item) => item.resultId === paymentResultId)).toHaveLength(1);
      expect(after.state.accountingObservations.filter((item) => item.resultId === accountingResultId)).toHaveLength(1);
      expect(
        after.state.accountingObservations.filter(
          (item) => item.correlation === invoice.accountingCorrelation && item.latest,
        ),
      ).toEqual([expect.objectContaining({ receipt, resultId: accountingResultId, status: 'SUCCESS' })]);
      return after.revision;
    }).pipe(Effect.mapError(safeTransportFailure)),
  );

  it.effect('live External reads only its assigned Task, Activity and B201 Counterparty', () =>
    Effect.gen(function* externalAssignedReads() {
      const session = yield* signIn('external@siampark.demo');
      const work = yield* authorize(session, 'siampark-work');
      const tasks = yield* readTasks({ resourceId: assignedTaskId }, work.credential, correlation(), work.options);
      expect(tasks.items.map((task) => task.ref.resourceId)).toEqual([assignedTaskId]);
      const relationships = yield* authorize(session, 'siampark-relationships');
      const activities = yield* readActivities(
        { resourceId: assignedActivityId },
        relationships.credential,
        correlation(),
        relationships.options,
      );
      expect(activities.items.map((activity) => activity.ref.resourceId)).toEqual([assignedActivityId]);
      expect(activities.emailObservations).toEqual([]);
      const [assignedActivity] = activities.items;
      if (assignedActivity?.counterpartyRef === undefined) {
        return yield* new LiveDemoPrerequisiteUnavailable({
          reason: 'The assigned B201 Activity has no Counterparty.',
        });
      }
      expect(assignedActivity.counterpartyRef.resourceId).toBe(assignedCounterpartyId);
      const party = yield* authorize(session, 'party-registry');
      const counterparty = yield* readCounterparty(
        { counterpartyRef: assignedActivity.counterpartyRef },
        party.credential,
        correlation(),
        party.options,
      );
      expect(counterparty.counterpartyRef).toEqual(assignedActivity.counterpartyRef);
      expect(counterparty.party.archived).toBe(false);
      return counterparty.counterpartyRef.resourceId;
    }).pipe(Effect.mapError(safeTransportFailure)),
  );

  it.effect('live External receives typed HTTP 403 for an unrelated Task, Invoice and Counterparty', () =>
    Effect.gen(function* externalDeniedReads() {
      const session = yield* signIn('external@siampark.demo');
      const work = yield* authorize(session, 'siampark-work');
      const task = yield* Effect.result(
        readTasks({ resourceId: unrelatedTaskId }, work.credential, correlation(), work.options),
      );
      expect(Result.match(task, { onFailure: Schema.is(TaskForbiddenSchema), onSuccess: () => false })).toBe(true);
      const finance = yield* authorize(session, 'siampark-billing-finance');
      const invoice = yield* Effect.result(
        readInvoices({ resourceId: invoiceId }, finance.credential, correlation(), finance.options),
      );
      expect(Result.match(invoice, { onFailure: Schema.is(InvoiceForbiddenSchema), onSuccess: () => false })).toBe(
        true,
      );
      const relationships = yield* authorize(session, 'siampark-relationships');
      const activities = yield* readActivities(
        { resourceId: assignedActivityId },
        relationships.credential,
        correlation(),
        relationships.options,
      );
      const [assignedActivity] = activities.items;
      if (assignedActivity?.counterpartyRef === undefined) {
        return yield* new LiveDemoPrerequisiteUnavailable({
          reason: 'The assigned B201 Activity has no Counterparty.',
        });
      }
      const unrelatedRef = yield* Schema.decodeEffect(CounterpartyRefSchema)({
        ...assignedActivity.counterpartyRef,
        resourceId: goldenCounterpartyId,
      });
      const party = yield* authorize(session, 'party-registry');
      const counterparty = yield* Effect.result(
        readCounterparty({ counterpartyRef: unrelatedRef }, party.credential, correlation(), party.options),
      );
      expect(Result.isFailure(counterparty)).toBe(true);
      if (Result.isFailure(counterparty)) {
        expect(Predicate.isTagged(counterparty.failure, 'CounterpartyReadForbiddenProblem')).toBe(true);
        if (Predicate.isTagged(counterparty.failure, 'CounterpartyReadForbiddenProblem')) {
          expect(counterparty.failure.status).toBe(403);
        }
      }
      return unrelatedRef.resourceId;
    }).pipe(Effect.mapError(safeTransportFailure)),
  );

  it.effect('live Operations commits only one of two Task changes at the same expected revision', () =>
    Effect.gen(function* operationsConcurrentRevision() {
      const session = yield* signIn('operations@siampark.demo');
      const initialGrant = yield* authorize(session, 'siampark-work');
      const before = yield* readTasks({}, initialGrant.credential, correlation(), initialGrant.options);
      const assigned = before.items.find((task) => task.ref.resourceId === assignedTaskId);
      if (assigned === undefined) {
        return yield* new LiveDemoPrerequisiteUnavailable({ reason: 'The assigned fixture Task is missing.' });
      }
      const state = assigned.state === 'IN_PROGRESS' ? 'WAITING' : 'IN_PROGRESS';
      const payload = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
        command: { _tag: 'ChangeTaskState', state, taskRef: assigned.ref },
        expectedRevision: before.revision,
      });
      const firstGrant = yield* authorize(session, 'siampark-work');
      const secondGrant = yield* authorize(session, 'siampark-work');
      expect(firstGrant.credential === secondGrant.credential).toBe(false);
      const firstKey = correlation();
      const secondKey = correlation();
      expect(firstKey).not.toBe(secondKey);
      const outcomes = yield* Effect.all(
        [
          Effect.result(
            executeApplyCommandWithAuthorization(payload, firstGrant.credential, correlation(), {
              ...firstGrant.options,
              idempotencyKey: firstKey,
            }),
          ),
          Effect.result(
            executeApplyCommandWithAuthorization(payload, secondGrant.credential, correlation(), {
              ...secondGrant.options,
              idempotencyKey: secondKey,
            }),
          ),
        ],
        { concurrency: 2 },
      );
      const successes = outcomes.filter(Result.isSuccess);
      const failures = outcomes.filter(Result.isFailure);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(successes[0]?.success).toMatchObject({ revision: before.revision + 1, task: { state } });
      const conflict = failures[0]?.failure;
      expect(Predicate.isTagged(conflict, 'ApplyCommandActionConflictProblem')).toBe(true);
      if (Predicate.isTagged(conflict, 'ApplyCommandActionConflictProblem')) {
        expect({ code: conflict.code, status: conflict.status }).toEqual({
          code: 'work_revision_conflict',
          status: 409,
        });
      }
      const finalGrant = yield* authorize(session, 'siampark-work');
      const after = yield* readTasks({}, finalGrant.credential, correlation(), finalGrant.options);
      expect(after.revision).toBe(before.revision + 1);
      expect(after.items).toHaveLength(before.items.length);
      expect(after.items.find((task) => task.ref.resourceId === assignedTaskId)?.state).toBe(state);
      expect(after.items.filter((task) => task.ref.resourceId !== assignedTaskId)).toEqual(
        before.items.filter((task) => task.ref.resourceId !== assignedTaskId),
      );
      return after.revision;
    }).pipe(Effect.mapError(safeTransportFailure)),
  );
});
