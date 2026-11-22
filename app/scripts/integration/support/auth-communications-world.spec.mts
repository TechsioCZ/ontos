/**
 * D3 (resolved): these end-to-end suites compose two verticals ONLY through their published testing seams.
 * Communications publishes `@app/communications/testing/source-owner-world` (its real intake, step and history Reads over
 * native PostgreSQL, with labelled doubles at every other owner's edge, plus the published Communication Request contract) and
 * Commerce Customer Context publishes `@app/commerce-customer-context/testing/portal-auth-communications` (its real Portal Auth
 * realms, protected handoff, outbox and relay). Neither seam imports the other vertical; the cross-owner glue in this folder is
 * the only place the two worlds meet, and it reaches no private file of either. A refactor of either vertical's private files
 * is absorbed by its seam; a change to a seam's shape is a change to a published testing contract.
 */
import {
  approvedMessageTypes,
  CommunicationRequestSchema,
  makeRuntimeDatabase,
  makeSourceOwnerWorld,
  messagingAdapterDouble,
  ProcessingScopeSchema,
  ProcessingScopeUndeclared,
  RecipientAuthorityUnavailable,
  RecipientGateVerdict,
  SourceOccurrenceUnavailable,
  SourceStateKeySchema,
} from '@app/communications/testing/source-owner-world';
import type {
  CommunicationRequestEncoded,
  MessagingAdapterDouble,
  PinnedHandoff,
  PrivacyOwnerTransport,
  ProviderEvidenceCase,
} from '@app/communications/testing/source-owner-world';
import {
  fillOwnerRenderedSlots,
  issuanceSourceStateOf,
  makePortalAuthSource,
  maskedAddressOf,
  originalEndpointOf,
  PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
  PORTAL_AUTH_EMAIL_FLOWS,
  PORTAL_ORIGIN,
  PortalAuthCommunicationUnavailable,
  portalAuthCommunicationPurposeOf,
  PortalAuthIssuanceRefSchema,
  portalAuthOwnerRenderedSlotOf,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import type {
  IssuanceLedgerProbe,
  PortalAuthEmailFlow,
  PortalAuthIntentSummary,
  PortalAuthSubmission,
  PreVerificationPrivacyTransportService,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import { Effect, Option, Schema } from 'effect';
import type { Redacted } from 'effect';

/**
 * TEST-ONLY world of the three Portal Auth e-mail flows (#1406). Everything on the Auth side is the REAL Auth source (see the
 * Portal Auth seam): a callback only commits its issuance and request; the suites' flow helpers then run ONE relay tick
 * (`world.relay`), as the production relay loop does within its interval, so a request reaches Communications only from the
 * committed outbox row. Everything on the Communications side is the REAL owner code (see the source-owner seam).
 *
 * LABELLED DOUBLES (each stands at the edge of ANOTHER owner and proves how that edge is READ, never that it answers so):
 * - the Privacy gate answers ALLOWED/NOT_ALLOWED/INDETERMINATE by script, so a positive answer here is NOT Privacy evidence
 *   (the real Privacy pre-verification contract is proven in `auth-communications-privacy-blocked.test.mts`);
 * - the pre-verification Privacy binding is a double of Privacy's bind Action: `evidencing: true` yields a FICTIONAL binding
 *   in Privacy's answer shape; `false` is Auth's composition without a transport to Privacy (D1, so no scope is declared).
 *   A suite that proves the positive path against the REAL Privacy owner passes `binding` and `privacyGate` instead: Auth's
 *   REAL binding and Communications' REAL Privacy-gate adapter then run, and only their transports to Privacy are the suite's;
 * - the trusted recipient language is scripted; Auth publishes no trusted locale source yet;
 * - the relay's transport to the public Action is in process: the request is decided by the REAL handler under the sealed
 *   registered-source-worker principal of `commerce.customer-context` (the carrier the production Outbox Worker obtains), with
 *   no HTTP gateway between them;
 * - the Messaging Adapter (step 22) renders the pinned revision with the REAL generic renderer, asks Auth's REAL owner-slot
 *   completion for the secret slot, and then "sends" into an in-memory mailbox with a scripted provider answer;
 * - the approved Czech and English COPY does not exist: every revision below is clearly FICTIONAL and labelled so.
 */

export const FICTIONAL_COPY = '[FICTIONAL TEST COPY]';

const decodeRequest = Schema.decodeUnknownSync(CommunicationRequestSchema);
const decodeScope = Schema.decodeUnknownSync(ProcessingScopeSchema);
const decodeIssuanceRef = Schema.decodeUnknownSync(PortalAuthIssuanceRefSchema);

export const flowOfPurpose = (purpose: string): PortalAuthEmailFlow | undefined =>
  PORTAL_AUTH_EMAIL_FLOWS.find((flow) => portalAuthCommunicationPurposeOf(flow) === purpose);

/** One message the labelled provider double was handed: the only place a secret and an address legitimately exist together. */
export interface Mail {
  readonly flow: PortalAuthEmailFlow;
  readonly html: Redacted.Redacted;
  readonly intentId: string;
  readonly language: string;
  readonly subject: string;
  readonly text: Redacted.Redacted;
  readonly to: Redacted.Redacted;
}

export interface AuthWorldOptions {
  /**
   * The transport to Privacy's bind Action, when a suite composes Auth's REAL pre-verification Privacy binding over it.
   * Default: the labelled double below, or Auth's fail-closed composition with `evidencing: false`.
   */
  readonly binding?: PreVerificationPrivacyTransportService;
  /** Whether the double of Privacy's bind Action evidences a binding. Default: yes (labelled double). */
  readonly evidencing?: boolean;
  readonly languages?: readonly ('cs' | 'en')[];
  readonly ledgerProbe?: IssuanceLedgerProbe;
  readonly mode?: 'A' | 'B';
  /** The transport to Privacy's Reads, when a suite composes Communications' REAL Privacy gate over it. Default: scripted. */
  readonly privacyGate?: PrivacyOwnerTransport;
  /** Approved types overriding the production catalog (a fictional recovery limit, for example). Default: production. */
  readonly types?: typeof approvedMessageTypes;
}

const slotOf = portalAuthOwnerRenderedSlotOf;

/** Approved FICTIONAL revisions: one per Auth type and language, each declaring its secret slot as a required placeholder. */
const fictionalRevisionOf = (type: (typeof approvedMessageTypes)[number], language: 'cs' | 'en') =>
  Option.map(Option.fromNullishOr(flowOfPurpose(type.purpose)), (flow) => ({
    body: `${FICTIONAL_COPY} ${language} ${flow}\n\nOpen this: {{${slotOf(flow)}}}\n\nIgnore this message if you did not ask for it.`,
    requiredPlaceholders: [slotOf(flow)],
    subject: `${FICTIONAL_COPY} ${language} ${flow}`,
  }));

const SUBMIT_OPERATION = 'submit-communication-request';

/**
 * One Tenant with approved FICTIONAL Czech and English revisions of the three Portal Auth types, the Auth protected handoff
 * and the owner doubles, over the real Communications persistence.
 */
export const authWorld = Effect.fn('AuthCommunicationsWorld.make')(function* makeWorld(options: AuthWorldOptions = {}) {
  const types = options.types ?? approvedMessageTypes;
  const owner = yield* makeSourceOwnerWorld(yield* makeRuntimeDatabase(), {
    languages: options.languages ?? ['cs', 'en'],
    mode: options.mode,
    privacyOwner: options.privacyGate,
    revisionOf: fictionalRevisionOf,
    types,
  });
  const { tenantId } = owner;
  const auth = yield* makePortalAuthSource({
    evidencing: options.evidencing,
    ledgerProbe: options.ledgerProbe,
    privacyTransport: options.binding,
    tenantId,
  });

  const sourceReads = { count: 0 };
  const mailbox: Mail[] = [];
  const submissions: { readonly request: CommunicationRequestEncoded; readonly submission: PortalAuthSubmission }[] =
    [];
  const outboxes: (readonly { readonly payloadJson: unknown; readonly topic: string }[])[] = [];
  const providerAnswer = {
    current: (_message: PinnedHandoff): ProviderEvidenceCase => ({
      kind: 'ACCEPTED',
      providerKey: 'fictional-provider',
      providerRef: 'fictional-ref',
    }),
  };
  const unavailableSubject = { current: false };
  /** The intake ADMITS the request and stores its decision, but the caller sees only "unavailable": a timeout after admission. */
  const lostAnswerSubject = { current: false };

  const intake = owner.intakeWith({
    recipientGate: {
      check: (query) =>
        Effect.gen(function* checkEndpoint() {
          const address = yield* originalEndpointOf(auth.handoff, {
            issuanceRef: decodeIssuanceRef(query.contact.contactRef.resourceId),
            recipientSubjectId: query.recipient.recipientRef.resourceId,
          }).pipe(Effect.mapError(() => new RecipientAuthorityUnavailable({ authority: 'SOURCE_OWNER' })));
          return Option.match(address, {
            onNone: () => RecipientGateVerdict.Unusable({ reason: 'SOURCE_NO_LONGER_VALID' }),
            onSome: (value) => {
              const endpoint = {
                channel: 'email',
                contactRef: query.contact.contactRef,
                mask: maskedAddressOf(value),
                value,
              };
              const { evidence } = query.contact;
              // The owner echoes the snapshot it resolved, exactly as the contact binding names it.
              return RecipientGateVerdict.Usable({
                endpoint:
                  evidence.kind === 'HISTORICAL_SNAPSHOT'
                    ? { ...endpoint, snapshotRef: evidence.snapshotRef }
                    : endpoint,
              });
            },
          });
        }),
    },
    scopeDeclaration: {
      declare: ({ request, type }) =>
        Effect.gen(function* declareScope() {
          const issuance = yield* auth.handoff
            .issuanceOf(decodeIssuanceRef(request.occurrence.occurrenceId))
            .pipe(Effect.mapError(() => new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' })));
          if (Option.isNone(issuance)) {
            return yield* new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' });
          }
          // the source declares the scope PRIVACY bound for this issuance: Privacy's subject and its policy's dimensions
          const bound = yield* auth.binding
            .bind(issuance.value)
            .pipe(Effect.mapError(() => new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' })));
          return decodeScope({
            catalogPurposeRef: type.privacyPurposeRefs[0],
            channel: 'email',
            controllerRef: bound.scope.controllerRef,
            dataCategoryRefs: bound.scope.dataCategoryRefs,
            operation: bound.scope.operation,
            processingScopeRef: bound.scope.processingScopeRef,
            purposeRef: bound.scope.purposeRef,
            purposeVersionId: bound.scope.purposeVersionId,
            recipientRefs: bound.scope.recipientRefs,
            subject: { bindingRef: bound.bindingRef, kind: 'PRIVACY_BINDING' },
          });
        }),
    },
    sourceAuthority: {
      read: (request) =>
        Effect.gen(function* readIssuance() {
          sourceReads.count += 1;
          const issuanceRef = decodeIssuanceRef(request.occurrence.occurrenceId);
          const currentness = yield* auth.handoff
            .currentness(issuanceRef)
            .pipe(Effect.mapError(() => new SourceOccurrenceUnavailable({ reason: 'OWNER_UNAVAILABLE' })));
          return {
            latestRevision: 1,
            occurrenceId: request.occurrence.occurrenceId,
            state: SourceStateKeySchema.make(issuanceSourceStateOf(currentness)),
            tenantId: request.tenantId,
          };
        }),
    },
  });

  /** The Messaging Adapter double: REAL generic rendering, REAL Auth owner-slot completion, then a scripted provider answer. */
  const messageHandoff = messagingAdapterDouble((message) =>
    Effect.gen(function* render() {
      const flow = flowOfPurpose(message.purpose);
      if (flow === undefined) {
        return { kind: 'REJECTED', reason: 'provider_rejected' } as const;
      }
      const rendered = yield* owner.renderPinned(message, { allowedOrigins: [PORTAL_ORIGIN], ownerSlot: slotOf(flow) });
      if (Option.isNone(rendered)) {
        return { kind: 'REJECTED', reason: 'provider_rejected' } as const;
      }
      // the issuance reaches Auth as the contact reference of the ORIGINAL endpoint that Auth itself bound
      const values = yield* auth.completion.complete({
        flow,
        issuanceRef: decodeIssuanceRef(message.endpoint.contactRef.resourceId),
        slots: rendered.value.ownerSlots,
      });
      const finished = fillOwnerRenderedSlots(rendered.value, values);
      mailbox.push({
        flow,
        html: finished.html,
        intentId: message.intentId,
        language: message.language,
        subject: finished.subject,
        text: finished.text,
        to: message.endpoint.value,
      });
      return providerAnswer.current(message);
    }).pipe(
      // an Auth refusal at the transport edge is a provider-side unavailability: nothing was submitted
      Effect.catchTag('OwnerSlotStop', () =>
        Effect.succeed({ kind: 'UNAVAILABLE', reason: 'provider_unavailable' } as const),
      ),
      Effect.orElseSucceed(() => ({ kind: 'UNAVAILABLE', reason: 'provider_unavailable' }) as const),
    ),
  );

  /** The relay's transport, in process: the REAL handler under the sealed registered-source-worker principal of the source module. */
  const submitter = {
    submit: (request: CommunicationRequestEncoded) =>
      Effect.gen(function* submit() {
        if (unavailableSubject.current) {
          return yield* new PortalAuthCommunicationUnavailable({ operation: SUBMIT_OPERATION });
        }
        const run = yield* intake
          .submit(decodeRequest(request), PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE)
          .pipe(Effect.mapError(() => new PortalAuthCommunicationUnavailable({ operation: SUBMIT_OPERATION })));
        const { result } = run;
        const submission: PortalAuthSubmission =
          result.outcome === 'CONFLICT'
            ? { originalDecisionId: result.originalDecisionId, outcome: 'CONFLICT', requestId: result.requestId }
            : {
                decision:
                  result.decision.kind === 'NO_MESSAGE'
                    ? { kind: 'NO_MESSAGE', reason: result.decision.reason }
                    : {
                        intents: result.decision.intents.map(({ intentId, reason, status }): PortalAuthIntentSummary =>
                          reason === undefined ? { intentId, status } : { intentId, reason, status },
                        ),
                        kind: 'MESSAGE_INTENTS',
                      },
                decisionId: result.decisionId,
                outcome: 'DECIDED',
                replayed: result.replayed,
                requestId: result.requestId,
              };
        submissions.push({ request, submission });
        outboxes.push(run.outbox);
        if (lostAnswerSubject.current) {
          return yield* new PortalAuthCommunicationUnavailable({ operation: SUBMIT_OPERATION });
        }
        return submission;
      }),
  };

  return {
    attemptRows: owner.attemptRows,
    everyStoredRow: owner.everyStoredRow,
    /** The protected handoff of the CURRENT Auth process. */
    get handoff() {
      return auth.handoff;
    },
    historyOfRequest: owner.historyOfRequest,
    historyReads: owner.historyReads,
    intentRows: owner.intentRows,
    languageRef: owner.languageRef,
    ledgerProbe: auth.ledgerProbe,
    lostAnswerSubject,
    mailbox,
    messageHandoff,
    outboxes,
    outboxRows: auth.outboxRows,
    privacyAnswers: owner.privacyAnswers,
    privacyQueries: owner.privacyQueries,
    providerAnswer,
    rawDelivery: auth.rawDelivery,
    recoveryStore: auth.recoveryStore,
    /** ONE relay tick over the Auth-local outbox of the current Auth process, through the world's transport. */
    relay: auth.relayThrough(submitter),
    restartAuth: auth.restart,
    sourceReads,
    step: intake.step,
    submissions,
    submitter,
    tenantId,
    unavailableSubject,
  };
});
export type AuthWorld = Effect.Success<ReturnType<typeof authWorld>>;

/** The intents the world's Communications decided that still wait for their pre-handoff step, in decision order. */
export const pendingIntentsOf = (world: AuthWorld) =>
  world.submissions.flatMap(({ submission }) =>
    submission.outcome === 'DECIDED' && submission.decision.kind === 'MESSAGE_INTENTS'
      ? submission.decision.intents.filter(({ status }) => status === 'PENDING_HANDOFF').map(({ intentId }) => intentId)
      : [],
  );

/** One delivery of the pre-handoff step of an intent, with the given Messaging Adapter double (the REAL worker step). */
export const step = (world: AuthWorld, handoff: MessagingAdapterDouble, intentId: string) =>
  world.step(handoff, intentId);

/** The safe history record of a request of the world's Tenant, as an owner-internal read; never a public Read. */
export const historyOfRequest = (world: AuthWorld, requestId: string) => world.historyOfRequest(requestId);

/** The issuance reference of the request at `index`, as Auth's own branded identity. */
export const issuanceRefOf = (world: AuthWorld, index = 0) =>
  PortalAuthIssuanceRefSchema.make(world.submissions[index]?.request.occurrence.occurrenceId ?? '');

/** The decision identity of a submission, or none for a conflict. */
export const decisionIdOf = (submission: PortalAuthSubmission) =>
  submission.outcome === 'DECIDED' ? submission.decisionId : submission.originalDecisionId;
