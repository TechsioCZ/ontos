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
  nativeServices,
  ProcessingScopeSchema,
  ProcessingScopeUndeclared,
} from '@app/communications/testing/source-owner-world';
import type {
  CommunicationRequestEncoded,
  MessagingAdapterDouble,
  PinnedHandoff,
  PortalAuthOwnerTransport,
  PrivacyOwnerTransport,
  ProviderEvidenceCase,
} from '@app/communications/testing/source-owner-world';
import {
  fillOwnerRenderedSlots,
  makePortalAuthSource,
  originalEndpointOf,
  PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
  PORTAL_AUTH_EMAIL_FLOWS,
  PORTAL_ORIGIN,
  PortalAuthCommunicationUnavailable,
  portalAuthCommunicationPurposeOf,
  portalAuthIssuanceSourceAnswer,
  PortalAuthIssuanceRefSchema,
  PORTAL_AUTH_RESOURCE_TYPE,
  portalAuthOwnerRenderedSlotOf,
  PreVerificationPrivacyBindingUnavailable,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import type {
  IssuanceLedgerProbe,
  PortalAuthEmailFlow,
  PortalAuthIntentSummary,
  PortalAuthSubmission,
  PreVerificationPrivacyTransportService,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import {
  makePreVerificationPrivacyNative,
  preVerificationPrivacyDatabaseLive,
} from '@app/privacy/testing/pre-verification-binding-native';
import type { PreVerificationPrivacyNative } from '@app/privacy/testing/pre-verification-binding-native';
import { Deferred, Effect, Layer, Option, Predicate, Schema } from 'effect';
import type { Redacted } from 'effect';
import { randomUUID } from 'node:crypto';

/**
 * TEST-ONLY world of the three Portal Auth e-mail flows (#1406). Everything on the Auth side is the REAL Auth source (see the
 * Portal Auth seam): a callback only commits its issuance and request; the suites' flow helpers then run ONE relay tick
 * (`world.relay`), as the production relay loop does within its interval, so a request reaches Communications only from the
 * committed outbox row. Everything on the Communications side is the REAL owner code (see the source-owner seam), and its
 * OWNER PORTS ARE THE PRODUCTION COMPOSITION (`communicationsOwnerPortsOver`): the source-occurrence authority and the recipient
 * gate are Communications' live Portal Auth adapters asking Auth's published Read, and the Privacy gate is Communications' live
 * adapter asking the REAL Privacy owner. This world accepts no source-authority, recipient-gate or Privacy-gate port (T1-04).
 *
 * REAL Privacy (always): Auth's REAL pre-verification binding asks Privacy's bind Action body, and the gate asks Privacy's
 * eligibility Read body, over Privacy's own table in native PostgreSQL as the runtime role (row-level security on). What is NOT
 * run there: the HTTP gateway, the access gate with SpiceDB and D1 (the production principal Auth would call Privacy under).
 * The Privacy POLICY values are FICTIONAL: no Privacy purpose, controller, scope or legal basis is approved for any Auth flow.
 *
 * LABELLED DOUBLES (each stands at the edge of ANOTHER owner and proves how that edge is READ, never that it answers so):
 * - the producer's Privacy-scope declaration (`producerScope` below): production deliberately declares NONE (an open owner gate,
 *   #1396 J: the source producer declares the scope and the Privacy owner has not confirmed the values), so the positive path
 *   uses the scope the SOURCE would declare from Auth's REAL binding over REAL Privacy. A world with `evidencing: false` is
 *   Auth's composition without a transport to Privacy: no scope is declared, as in production today;
 * - the transport of Communications' Auth adapters to Auth's published Read runs the Read's REAL answer body (state, binding and
 *   mask only) in process: the generated HTTP client and the Shell delegated assertion are NOT run here;
 * - the trusted recipient language is production's (none established, so `cs`); a suite that needs a trusted language asks for
 *   `recipientLanguage: 'LABELLED_DOUBLE'`, because no owner publishes one (R-D12);
 * - the relay's transport to the public Action is in process: the request is decided by the REAL handler under the sealed
 *   registered-source-worker principal of `commerce.customer-context` (the carrier the production Outbox Worker obtains), with
 *   no HTTP gateway between them (the HTTP leg is proven in `production-http-authorization.test.ts`);
 * - the Messaging Adapter (step 22) resolves the original address from Auth itself (as the real adapter must: Auth's Read never
 *   discloses it), renders the pinned revision with the REAL generic renderer, asks Auth's REAL owner-slot completion for the
 *   secret slot, and then "sends" into an in-memory mailbox with a scripted provider answer. It is NOT delivery evidence;
 * - every Tenant revision below is clearly FICTIONAL and labelled so; a Portal Auth language the suite seeds no revision
 *   for has no text at all: only a revision an administrator activated is used (#1398, R-D1), so its message is not sent.
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
   * Whether Auth composes its REAL binding over the REAL Privacy owner (default) or the composition WITHOUT a transport to
   * Privacy (`false`, D1): no scope is declared, exactly as in production today.
   */
  readonly evidencing?: boolean;
  /** The languages with an own FICTIONAL revision; any other Portal Auth language has no text and its message is not sent. */
  readonly languages?: readonly ('cs' | 'en')[];
  readonly ledgerProbe?: IssuanceLedgerProbe;
  /**
   * The legal basis of the FICTIONAL Privacy policies. `CONSENT` is a basis that needs a Consent nobody can have given for an
   * unverified address, so the REAL Privacy owner answers INDETERMINATE. Default `CONTRACT`: ALLOWED while nothing blocks.
   */
  readonly legalBasis?: 'CONSENT' | 'CONTRACT';
  readonly mode?: 'A' | 'B';
  /** `LABELLED_DOUBLE` only for a suite that needs a trusted language: no owner publishes one (R-D12). */
  readonly recipientLanguage?: 'LABELLED_DOUBLE' | 'PRODUCTION';
  /** The languages the Tenant took over and then deactivated: no text is in force, nothing is sent. */
  readonly retiredLanguages?: readonly ('cs' | 'en')[];
  /** Approved types overriding the production catalog (a fictional recovery limit, for example). Default: production. */
  readonly types?: typeof approvedMessageTypes;
  /** `false`: the Privacy owner holds NO policy, so it refuses to bind. Default: one FICTIONAL policy per Auth flow. */
  readonly withPrivacyPolicies?: boolean;
}

/** The services every world needs: the runtime-role Communications database and Privacy's own native ledger. */
export const worldServices = Layer.mergeAll(nativeServices, preVerificationPrivacyDatabaseLive);

/** A FICTIONAL Privacy owner policy for one Auth flow in one Tenant, with no Legal Entity: test data, never a product value. */
const fictionalPolicy = (tenantId: string, flow: PortalAuthEmailFlow, legalBasis: 'CONSENT' | 'CONTRACT') =>
  ({
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    legalBasisRef: `fictional-legal-basis:${legalBasis.toLowerCase()}`,
    policyRef: `fictional-policy:${flow}`,
    revision: 'fictional-r1',
    scope: {
      controllerRef: 'fictional-controller',
      dataCategoryRefs: ['fictional:contact'],
      operation: 'FICTIONAL_SEND_AUTH_MESSAGE',
      processingScopeRef: { scopeId: `fictional-scope:${flow}`, scopeType: 'privacy.processing-scope' },
      purposeRef: `fictional-purpose:${flow}`,
      purposeVersionId: 'fictional-purpose-v1',
      recipientRefs: ['fictional.communications'],
    },
    sourceModuleId: PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
    sourcePurposeRef: portalAuthCommunicationPurposeOf(flow),
    sourceResourceType: PORTAL_AUTH_RESOURCE_TYPE.account,
    tenantId,
    validUntil: '2099-01-01T00:00:00.000Z',
  }) as const;

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
  const evidencing = options.evidencing !== false;
  const privacySeam = yield* Deferred.make<PreVerificationPrivacyNative>();
  const principalId = randomUUID();
  const tenantRef = { current: '' };
  const callAs = (callerAppId: string) => ({ callerAppId, principalId, tenantId: tenantRef.current });
  /** Every request either side put to Privacy (the bind and the eligibility Reads), so a suite can scan what crossed. */
  const privacyAsked: unknown[] = [];
  const privacyBindings: string[] = [];
  /** Set to make Privacy's own withdrawal land before the next eligibility answer: a prohibition Privacy itself records. */
  const prohibition = { pending: false };
  const withdrawAll = (privacy: PreVerificationPrivacyNative) =>
    Effect.forEach(
      [...new Set(privacyBindings)],
      (bindingRef) => privacy.withdraw(callAs('privacy'), { bindingRef, evidenceRef: 'fictional-dsr-case' }),
      { discard: true },
    );
  // Communications' PRODUCTION Privacy gate asks Privacy's eligibility Read body as the verified calling module `communications`
  const privacyOwner: PrivacyOwnerTransport = (question) => {
    privacyAsked.push(question.request);
    return question.kind === 'PRE_VERIFICATION'
      ? Deferred.await(privacySeam).pipe(
          Effect.tap((privacy) =>
            prohibition.pending
              ? withdrawAll(privacy).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      prohibition.pending = false;
                    }),
                  ),
                )
              : Effect.void,
          ),
          Effect.flatMap((privacy) => privacy.eligibility(callAs('communications'), question.request)),
          Effect.mapError((cause) => ({ cause, status: 503 })),
        )
      : Effect.fail({ status: 503 });
  };
  // Auth's REAL binding asks Privacy's bind Action body as the verified calling module `commerce-customer-context`
  const bindingTransport: PreVerificationPrivacyTransportService = {
    bind: (payload) =>
      Deferred.await(privacySeam).pipe(
        Effect.tap(() => Effect.sync(() => privacyAsked.push(payload))),
        Effect.flatMap((privacy) => privacy.bind(callAs('commerce-customer-context'), payload)),
        Effect.tap((bound) => Effect.sync(() => privacyBindings.push(bound.bindingRef))),
        Effect.mapError(
          (failure) =>
            new PreVerificationPrivacyBindingUnavailable({
              reason: Predicate.isTagged(failure, 'PreVerificationBindingRejected')
                ? 'PRIVACY_REFUSED'
                : 'PRIVACY_UNAVAILABLE',
            }),
        ),
      ),
  };

  const owner = yield* makeSourceOwnerWorld(yield* makeRuntimeDatabase(), {
    languages: options.languages ?? ['cs', 'en'],
    mode: options.mode,
    privacyOwner,
    recipientLanguage: options.recipientLanguage,
    retiredLanguages: options.retiredLanguages,
    revisionOf: fictionalRevisionOf,
    types,
  });
  const { tenantId } = owner;
  tenantRef.current = tenantId;
  const privacy = yield* makePreVerificationPrivacyNative(
    options.withPrivacyPolicies === false
      ? []
      : PORTAL_AUTH_EMAIL_FLOWS.map((flow) => fictionalPolicy(tenantId, flow, options.legalBasis ?? 'CONTRACT')),
  );
  yield* Deferred.succeed(privacySeam, privacy);
  const auth = yield* makePortalAuthSource({
    evidencing,
    ledgerProbe: options.ledgerProbe,
    privacyTransport: evidencing ? bindingTransport : undefined,
    tenantId,
  });

  /** Every question Communications' PRODUCTION Auth adapters put to Auth's published Read, in order. */
  const authAsked: Parameters<PortalAuthOwnerTransport>[0][] = [];
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

  /**
   * How the PRODUCTION Communications adapters reach Auth's published owner Read: the Read's REAL answer body over the
   * protected handoff of the CURRENT Auth process. The generated HTTP client and the Shell delegated assertion are not run.
   */
  const portalAuth: PortalAuthOwnerTransport = (question) => {
    authAsked.push(question);
    return portalAuthIssuanceSourceAnswer(question, { handoff: Option.some(auth.handoff) }).pipe(
      Effect.mapError(() => ({ status: 503 })),
    );
  };

  /**
   * The labelled PRODUCER double: the scope the SOURCE would declare for an issuance, from Auth's REAL binding over REAL Privacy.
   * Production declares none (#1396 J), so this is the only owner-gated port that is not production's.
   */
  const producerScope = {
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
  } satisfies Parameters<typeof owner.intakeOnProduction>[0]['producerScope'];

  const intake = owner.intakeOnProduction({ portalAuth, producerScope });

  /** The Messaging Adapter double: the original address from Auth, REAL generic rendering, REAL Auth owner-slot completion, then a scripted provider answer. */
  const messageHandoff = messagingAdapterDouble((message) =>
    Effect.gen(function* render() {
      const flow = flowOfPurpose(message.purpose);
      if (flow === undefined) {
        return { kind: 'REJECTED', reason: 'provider_rejected' } as const;
      }
      const issuanceRef = decodeIssuanceRef(message.endpoint.contactRef.resourceId);
      // Auth's Read never discloses the address: the adapter resolves the ORIGINAL one from Auth itself, for this account only
      const address = yield* originalEndpointOf(auth.handoff, {
        issuanceRef,
        recipientSubjectId: message.recipientRef.resourceId,
      });
      if (Option.isNone(address)) {
        return { kind: 'UNAVAILABLE', reason: 'provider_unavailable' } as const;
      }
      const rendered = yield* owner.renderPinned(message, { allowedOrigins: [PORTAL_ORIGIN], ownerSlot: slotOf(flow) });
      if (Option.isNone(rendered)) {
        return { kind: 'REJECTED', reason: 'provider_rejected' } as const;
      }
      // the issuance reaches Auth as the contact reference of the ORIGINAL endpoint that Auth itself bound
      const values = yield* auth.completion.complete({
        flow,
        issuanceRef,
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
        to: address.value,
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
    authAsked,
    everyStoredRow: owner.everyStoredRow,
    /** The protected handoff of the CURRENT Auth process. */
    get handoff() {
      return auth.handoff;
    },
    historyOfRequest: owner.historyOfRequest,
    historyReads: owner.historyReads,
    intentRows: owner.intentRows,
    ledgerProbe: auth.ledgerProbe,
    lostAnswerSubject,
    mailbox,
    messageHandoff,
    outboxes,
    outboxRows: auth.outboxRows,
    ownerPortSources: owner.ownerPortSources,
    /** The Privacy owner of the world, for a suite that withdraws or inspects a binding as Privacy itself would. */
    privacy,
    privacyAsked,
    privacyBindings,
    /** The eligibility questions Privacy was asked (decision and last stoppable handoff), as Communications built them. */
    get privacyQueries() {
      return privacyAsked.filter((request) => Predicate.hasProperty(request, 'bindingRef'));
    },
    /** Privacy ITSELF withdraws every binding now (a data-subject withdrawal it records): the next eligibility answer is NOT_ALLOWED. */
    withdrawBindings: Effect.suspend(() => withdrawAll(privacy)),
    /** Privacy ITSELF withdraws the bindings before its next eligibility answer: a prohibition the owner records. */
    prohibitProcessing: () => {
      prohibition.pending = true;
    },
    providerAnswer,
    rawDelivery: auth.rawDelivery,
    /** The Tenant's authorised user replacing one text with an own revision (prepare + activate). */
    recoveryStore: auth.recoveryStore,
    replaceTemplate: owner.replaceTemplate,
    /** ONE relay tick over the Auth-local outbox of the current Auth process, through the world's transport. */
    relay: auth.relayThrough(submitter),
    restartAuth: auth.restart,
    setTrustedLanguage: owner.setTrustedLanguage,
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
