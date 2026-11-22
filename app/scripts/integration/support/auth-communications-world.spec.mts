/**
 * OPEN ITEM (D3): these end-to-end suites reach into the PRIVATE source and tests of two verticals (Communications and
 * Commerce Customer Context, with its Portal Auth realm) by relative path, because neither of them publishes a testing seam for what
 * they need. The established seam is `@app/<vertical>/testing/*` exports (a vertical's own labelled doubles and worlds); until
 * Communications and Commerce Customer Context publish theirs, this suite is a test of the INTEGRATION and must be read as
 * coupled to those internals: a refactor of either vertical's private files is expected to break it, and the fix is to publish
 * the seam, never to widen the private reach.
 */
import { CommunicationRequestSchema } from '../../../packages/communications-contracts/src/communication-request.ts';
import type { CommunicationRequestEncoded } from '../../../packages/communications-contracts/src/communication-request.ts';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Layer, Match, Option, Ref, Result, Schema } from 'effect';
import type { Redacted } from 'effect';
import { createHash, randomBytes } from 'node:crypto';

import { CommercePortalAuthRawEmailDeliveryService } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/raw-email-delivery-service.ts';
import { CommercePortalAuthIssuedFacts } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/issued-facts.ts';
import type { IssuedFactsService } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/issued-facts.ts';
import type { CommercePortalAuthRecoveryStore } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/recovery/store-service.ts';
import { CommercePortalAuthCommunicationsEmailLive } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/communications-email-delivery.ts';
import {
  PORTAL_AUTH_EMAIL_FLOWS,
  portalAuthCommunicationPurposeOf,
  portalAuthOwnerRenderedSlotOf,
  PortalAuthIssuanceRefSchema,
} from '../../../verticals/commerce-customer-context/shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../../verticals/commerce-customer-context/shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/communication-request-submitter.ts';
import type {
  PortalAuthIntentSummary,
  PortalAuthSubmission,
} from '../../../verticals/commerce-customer-context/src/portal-auth/communications/communication-request-submitter.ts';
import { PortalAuthCommunicationUnavailable } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/communication-unavailable.ts';
import {
  issuanceSourceStateOf,
  maskedAddressOf,
  originalEndpointOf,
} from '../../../verticals/commerce-customer-context/src/portal-auth/communications/owner-facts.ts';
import {
  CommercePortalAuthOwnerSlotCompletion,
  fillOwnerRenderedSlots,
  ownerSlotCompletionLayer,
} from '../../../verticals/commerce-customer-context/src/portal-auth/communications/owner-completion.ts';
import {
  CommercePortalAuthPreVerificationPrivacyBinding,
  unsupportedPreVerificationPrivacyBindingLayer,
} from '../../../verticals/commerce-customer-context/src/portal-auth/communications/pre-verification-privacy-binding.ts';
import type { IssuanceLedgerProbe } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/protected-handoff.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayer,
} from '../../../verticals/commerce-customer-context/src/portal-auth/communications/protected-handoff.ts';
import { CommercePortalAuthTrustedScope } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/trusted-scope.ts';
import { BindPreVerificationSubjectResultSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import { approvedMessageTypes } from '../../../verticals/communications/src/domain/catalog/approved-registry.ts';
import { SourceStateKeySchema } from '../../../verticals/communications/src/domain/catalog/vocabulary.ts';
import type {
  PinnedHandoff,
  ProviderEvidenceCase,
} from '../../../verticals/communications/src/domain/handoff/message-handoff.ts';
import { approvedCatalogLayer } from '../../../verticals/communications/src/domain/intake/message-type-catalog.ts';
import { RecipientLanguageAuthority } from '../../../verticals/communications/src/domain/intake/recipient-language.ts';
import { ProcessingScopeDeclaration } from '../../../verticals/communications/src/domain/intake/scope-declaration.ts';
import { ProcessingScopeUndeclared } from '../../../verticals/communications/src/domain/intake/scope-declaration-errors.ts';
import { SourceOccurrenceAuthority } from '../../../verticals/communications/src/domain/intake/source-authority.ts';
import { SourceOccurrenceUnavailable } from '../../../verticals/communications/src/domain/intake/source-authority-errors.ts';
import { renderMessage } from '../../../verticals/communications/src/domain/language/interpolation.ts';
import type { RecipientLanguageContext } from '../../../verticals/communications/src/domain/language/vocabulary.ts';
import { ProcessingEligibilityGate } from '../../../verticals/communications/src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityQuery } from '../../../verticals/communications/src/domain/privacy/eligibility-gate.ts';
import { ProcessingScopeSchema } from '../../../verticals/communications/src/domain/privacy/processing-scope.ts';
import { RecipientAuthorityUnavailable } from '../../../verticals/communications/src/domain/recipient/current-gate-errors.ts';
import {
  RecipientCurrentGate,
  RecipientGateVerdict,
} from '../../../verticals/communications/src/domain/recipient/current-gate.ts';
import {
  HandoffStoreUnavailable,
  processIntentHandoff,
} from '../../../verticals/communications/src/handoff/process-intent-handoff.ts';
import type { ScopedRunner } from '../../../verticals/communications/src/handoff/process-intent-handoff.ts';
import { loadRequestHistory } from '../../../verticals/communications/src/services/message-history.service.ts';
import {
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
} from '../../../verticals/communications/shared/communication-intake.ts';
import { setLanguageMode } from '../../../verticals/communications/src/services/language-policy-domain.service.ts';
import { handoffDouble } from '../../../verticals/communications/tests/support/intake-fixtures.ts';
import { documentOwnerDouble } from '../../../verticals/communications/tests/support/document-owner-double.ts';
import { intakeRunnerOver } from '../../../verticals/communications/tests/support/intake-runner.ts';
import {
  actorWith,
  makeRuntimeDatabase,
  nextId,
} from '../../../verticals/communications/tests/support/persistence.fixture.ts';
import {
  actorFor,
  domainFor,
  fictionalDraft,
  identity,
} from '../../../verticals/communications/tests/support/template-fixtures.ts';
import { privacyAllowed } from '../../../verticals/communications/tests/unit/support/privacy-fixtures.ts';
import { TEST_GATE_CHECK_TIMEOUT } from '../../../verticals/communications/tests/unit/support/recipient-fixtures.ts';

/**
 * TEST-ONLY world of the three Portal Auth e-mail flows (#1406). Everything on the Auth side is the REAL Auth source: the
 * Better Auth realm callbacks, the recovery ledger, the Communications-routed delivery, the protected handoff, the owner-slot
 * completion and the enrollment gateway. Everything on the Communications side is the REAL owner code over native PostgreSQL
 * as the runtime role: the public `submit-communication-request` handler, the durable decision and intents, the pre-handoff
 * step and the history Reads.
 *
 * LABELLED DOUBLES (each stands at the edge of ANOTHER owner and proves how that edge is READ, never that it answers so):
 * - the Privacy gate answers ALLOWED/NOT_ALLOWED/INDETERMINATE by script, so a positive answer here is NOT Privacy evidence
 *   (the real Privacy pre-verification contract is proven in `auth-communications-privacy-blocked.test.mts`);
 * - the pre-verification Privacy binding is a double of Privacy's bind Action: `evidencing: true` yields a FICTIONAL binding;
 *   `false` is Auth's production composition without a transport to Privacy (D1, so no scope is declared). A suite that
 *   proves the positive path against the REAL Privacy owner passes `binding` and `privacyGate` instead;
 * - the trusted recipient language is scripted; Auth publishes no trusted locale source yet;
 * - the Messaging Adapter (step 22) renders the pinned revision with the REAL generic renderer, asks Auth's REAL owner-slot
 *   completion for the secret slot, and then "sends" into an in-memory mailbox with a scripted provider answer;
 * - the approved Czech and English COPY does not exist: every revision below is clearly FICTIONAL and labelled so.
 */

export const FICTIONAL_COPY = '[FICTIONAL TEST COPY]';
export const PORTAL_ORIGIN = 'https://portal.example.test';

export const cryptoLive = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    digest: (algorithm, data) =>
      Effect.sync(() => new Uint8Array(createHash(algorithm.toLowerCase().replace('-', '')).update(data).digest())),
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
  }),
);

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
   * Auth's pre-verification Privacy binding, when a suite composes the REAL one (Privacy's bind Action over a transport).
   * Default: the labelled double below, or Auth's fail-closed composition with `evidencing: false`.
   */
  readonly binding?: Layer.Layer<CommercePortalAuthPreVerificationPrivacyBinding>;
  /** Whether the double of the pre-verification Privacy binding evidences a binding. Default: yes (labelled double). */
  readonly evidencing?: boolean;
  readonly languages?: readonly ('cs' | 'en')[];
  readonly ledgerProbe?: IssuanceLedgerProbe;
  readonly mode?: 'A' | 'B';
  /** The Privacy gate, when a suite composes the REAL one (Communications' adapter over Privacy). Default: the scripted gate. */
  readonly privacyGate?: Layer.Layer<ProcessingEligibilityGate>;
  /** Approved types overriding the production catalog (a fictional recovery limit, for example). Default: production. */
  readonly types?: typeof approvedMessageTypes;
}

const slotOf = portalAuthOwnerRenderedSlotOf;

/**
 * One Tenant with approved FICTIONAL Czech and English revisions of the three Portal Auth types, the Auth protected handoff
 * and the owner doubles, over the real Communications persistence.
 */
const SUBMIT_OPERATION = 'submit-communication-request';

/** The FICTIONAL binding the labelled double answers with, in the shape of Privacy's published bind result. */
const fictionalPrivacyBinding = (tenantId: string) => ({
  bindingRef: '00000000-0000-4000-8000-00000000b1d0',
  policy: { policyRef: 'fictional-policy', revision: 'fictional-r1' },
  scope: {
    controllerRef: 'fictional-controller',
    dataCategoryRefs: ['fictional:contact'],
    operation: 'FICTIONAL_SEND_AUTH_MESSAGE',
    processingScopeRef: { scopeId: 'fictional-scope', scopeType: 'privacy.processing-scope' },
    purposeRef: 'fictional-purpose',
    purposeVersionId: 'fictional-v1',
    recipientRefs: ['fictional.communications'],
    subjectRef: {
      moduleId: 'privacy.core',
      resourceId: '00000000-0000-4000-8000-00000000b1d0',
      resourceType: 'privacy.core.privacy-subject',
      tenantId,
    },
  },
  status: 'ACTIVE',
  validUntil: '2099-01-01T00:00:00.000Z',
});

export const authWorld = Effect.fn('AuthCommunicationsWorld.make')(function* makeWorld(options: AuthWorldOptions = {}) {
  const database = yield* makeRuntimeDatabase();
  const tenantId = yield* nextId;
  const types = options.types ?? approvedMessageTypes;
  const languages = options.languages ?? ['cs', 'en'];

  // approved FICTIONAL revisions: one per type and language, each declaring its secret slot as a required placeholder
  yield* database.withPorts(tenantId, (templates, policies) =>
    Effect.gen(function* seed() {
      const t = domainFor(templates);
      const actor = actorFor(null);
      for (const type of types) {
        const flow = flowOfPurpose(type.purpose);
        if (flow === undefined) {
          continue;
        }
        for (const language of languages) {
          const slot = slotOf(flow);
          const prepared = yield* t.prepare(
            fictionalDraft({
              ...identity({ channel: 'email', language, messageType: type.typeId, scope: { kind: 'tenant' } }),
              body: `${FICTIONAL_COPY} ${language} ${flow}\n\nOpen this: {{${slot}}}\n\nIgnore this message if you did not ask for it.`,
              optionalPlaceholders: [],
              requiredPlaceholders: [slot],
              subject: `${FICTIONAL_COPY} ${language} ${flow}`,
            }),
            actor,
          );
          yield* t.approve(prepared.revision.revisionId, actor);
        }
      }
      if (options.mode !== undefined) {
        yield* setLanguageMode(policies, options.mode, {
          actionInvocationId: yield* nextId,
          principalId: actorWith(tenantId).principalId,
        });
      }
    }),
  );

  // the Auth side: one protected handoff of this "process"; a realm that owns a real recovery ledger installs its probe here
  const ledgerProbe = {
    current: options.ledgerProbe ?? ((): ReturnType<IssuanceLedgerProbe> => Effect.succeed('CURRENT')),
  } satisfies { current: IssuanceLedgerProbe };
  const handoff = yield* CommercePortalAuthProtectedHandoff.pipe(
    Effect.provide(protectedHandoffLayer((held) => ledgerProbe.current(held))),
  );
  const completion = yield* CommercePortalAuthOwnerSlotCompletion.pipe(
    Effect.provide(
      ownerSlotCompletionLayer.pipe(Layer.provide(Layer.succeed(CommercePortalAuthProtectedHandoff, handoff))),
    ),
  );
  const doubleBinding =
    options.evidencing === false
      ? unsupportedPreVerificationPrivacyBindingLayer
      : Layer.succeed(CommercePortalAuthPreVerificationPrivacyBinding, {
          // LABELLED DOUBLE of Privacy's bind Action: a FICTIONAL binding in Privacy's answer shape, never Privacy evidence
          bind: () =>
            Schema.decodeUnknownEffect(BindPreVerificationSubjectResultSchema)(fictionalPrivacyBinding(tenantId)).pipe(
              Effect.orDie,
            ),
        });
  const binding = yield* CommercePortalAuthPreVerificationPrivacyBinding.pipe(
    Effect.provide(options.binding ?? doubleBinding),
  );

  const language = Ref.makeUnsafe<RecipientLanguageContext>({ kind: 'not-established' });
  const privacyAnswers = new Map<string, typeof privacyAllowed>();
  const privacyQueries: ProcessingEligibilityQuery[] = [];
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

  const sourceAuthority = Layer.succeed(SourceOccurrenceAuthority, {
    read: (request) =>
      Effect.gen(function* readIssuance() {
        sourceReads.count += 1;
        const issuanceRef = decodeIssuanceRef(request.occurrence.occurrenceId);
        const currentness = yield* handoff
          .currentness(issuanceRef)
          .pipe(Effect.mapError(() => new SourceOccurrenceUnavailable({ reason: 'OWNER_UNAVAILABLE' })));
        return {
          latestRevision: 1,
          occurrenceId: request.occurrence.occurrenceId,
          state: SourceStateKeySchema.make(issuanceSourceStateOf(currentness)),
          tenantId: request.tenantId,
        };
      }),
  });
  const recipientGate = Layer.succeed(RecipientCurrentGate, {
    check: (query) =>
      Effect.gen(function* checkEndpoint() {
        const address = yield* originalEndpointOf(handoff, {
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
                evidence.kind === 'HISTORICAL_SNAPSHOT' ? { ...endpoint, snapshotRef: evidence.snapshotRef } : endpoint,
            });
          },
        });
      }),
    checkTimeout: TEST_GATE_CHECK_TIMEOUT,
  });
  const scopeDeclaration = Layer.succeed(ProcessingScopeDeclaration, {
    declare: ({ request, type }) =>
      Effect.gen(function* declareScope() {
        const issuance = yield* handoff.issuanceOf(decodeIssuanceRef(request.occurrence.occurrenceId));
        if (Option.isNone(issuance)) {
          return yield* new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' });
        }
        // the source declares the scope PRIVACY bound for this issuance: Privacy's subject and its policy's dimensions
        const bound = yield* binding
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
  });
  const languageLayer = Layer.succeed(RecipientLanguageAuthority, { languageOf: () => Ref.get(language) });
  const privacyLayer =
    options.privacyGate ??
    Layer.succeed(ProcessingEligibilityGate, {
      check: (query) => {
        privacyQueries.push(query);
        return (privacyAnswers.get(query.recipient.recipientRef.resourceId) ?? privacyAllowed)(query);
      },
      checkTimeout: TEST_GATE_CHECK_TIMEOUT,
    });
  const documents = documentOwnerDouble();

  /** The Messaging Adapter double: REAL generic rendering, REAL Auth owner-slot completion, then a scripted provider answer. */
  const messageHandoff = handoffDouble((message) =>
    Effect.gen(function* render() {
      const flow = flowOfPurpose(message.purpose);
      if (flow === undefined) {
        return { kind: 'REJECTED', reason: 'provider_rejected' } as const;
      }
      const revision = yield* database.withPort(message.tenantId, (port) =>
        port.loadRevision(message.template.revisionId),
      );
      if (Option.isNone(revision)) {
        return { kind: 'REJECTED', reason: 'provider_rejected' } as const;
      }
      const slot = slotOf(flow);
      const rendered = renderMessage({
        contract: [{ kind: 'owner-rendered', name: slot }],
        language: message.language,
        linkPolicy: { allowedOrigins: [PORTAL_ORIGIN] },
        template: {
          body: revision.value.body,
          optionalPlaceholders: revision.value.optionalPlaceholders,
          requiredPlaceholders: revision.value.requiredPlaceholders,
          subject: revision.value.subject,
        },
        values: {},
      });
      if (Result.isFailure(rendered)) {
        return { kind: 'REJECTED', reason: 'provider_rejected' } as const;
      }
      // the issuance reaches Auth as the contact reference of the ORIGINAL endpoint that Auth itself bound
      const values = yield* completion.complete({
        flow,
        issuanceRef: decodeIssuanceRef(message.endpoint.contactRef.resourceId),
        slots: rendered.success.ownerSlots,
      });
      const finished = fillOwnerRenderedSlots(rendered.success, values);
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

  const portsFor = (catalog: typeof approvedMessageTypes) =>
    Layer.mergeAll(
      approvedCatalogLayer(catalog),
      languageLayer,
      sourceAuthority,
      scopeDeclaration,
      recipientGate,
      privacyLayer,
      documents.layer,
      NodeCrypto.layer,
    );
  const runner = intakeRunnerOver(database, portsFor(types));

  /** The adapter that stands where the registered Auth after-commit worker would call the public Action. */
  const submitter = {
    submit: (request: CommunicationRequestEncoded) =>
      Effect.gen(function* submit() {
        if (unavailableSubject.current) {
          return yield* new PortalAuthCommunicationUnavailable({ operation: SUBMIT_OPERATION });
        }
        const run = yield* runner
          .submit(tenantId, decodeRequest(request), undefined, 'commerce.customer-context')
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

  /** The realm's real recovery store, set once its realm exists: the delivery reads Auth's stored expiry and one-time code challenge from it. */
  const recoveryStore = yield* Ref.make(Option.none<CommercePortalAuthRecoveryStore>());
  const throughRealmStore = <Value, Failure>(
    read: (store: CommercePortalAuthRecoveryStore) => Effect.Effect<Value, Failure>,
  ) =>
    Ref.get(recoveryStore).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.die('no Portal Auth realm is bound to the world'), onSome: read }),
      ),
    );
  const delegatingStore = {
    locateOtpChallenge: (input) => throughRealmStore((store) => store.locateOtpChallenge(input)),
    peekEmailVerificationLedger: (input) => throughRealmStore((store) => store.peekEmailVerificationLedger(input)),
    peekPasswordResetLedger: (input) => throughRealmStore((store) => store.peekPasswordResetLedger(input)),
  } satisfies IssuedFactsService;

  const rawDelivery = yield* CommercePortalAuthRawEmailDeliveryService.pipe(
    Effect.provide(
      CommercePortalAuthCommunicationsEmailLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CommercePortalAuthProtectedHandoff, handoff),
            Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, submitter),
            Layer.succeed(CommercePortalAuthTrustedScope, { current: Effect.succeed({ tenantId }) }),
            Layer.succeed(CommercePortalAuthIssuedFacts, delegatingStore),
            cryptoLive,
          ),
        ),
      ),
    ),
  );

  return {
    binding,
    completion,
    database,
    documents,
    handoff,
    languageRef: language,
    ledgerProbe,
    lostAnswerSubject,
    mailbox,
    messageHandoff,
    outboxes,
    portsFor,
    privacyAnswers,
    privacyQueries,
    providerAnswer,
    rawDelivery,
    read: <Row,>(
      select: (
        transaction: Parameters<Parameters<typeof database.inTenant>[1]>[0],
      ) => Effect.Effect<readonly Row[], unknown>,
    ) => database.inTenant(tenantId, select),
    recoveryStore,
    runner,
    sourceReads,
    submissions,
    submitter,
    tenantId,
    types,
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

const scopedRunnerOf =
  (world: AuthWorld): ScopedRunner =>
  (program) =>
    world.database
      .inTenant(world.tenantId, (transaction) => program(transaction))
      .pipe(
        Effect.mapError((failure) =>
          Match.value(failure).pipe(
            Match.tag('HandoffStoreUnavailable', (known) => known),
            Match.orElse(() => new HandoffStoreUnavailable({ reason: 'test database' })),
          ),
        ),
      );

/** One delivery of the pre-handoff step of an intent, with the given Messaging Adapter double (the REAL worker step). */
export const step = (world: AuthWorld, handoff: AuthWorld['messageHandoff'], intentId: string) =>
  processIntentHandoff(
    { intentId: MessageIntentIdSchema.make(intentId), tenantId: world.tenantId },
    scopedRunnerOf(world),
  ).pipe(Effect.provide(Layer.mergeAll(world.portsFor(world.types), handoff.layer, NodeCrypto.layer)));

/** The safe history record of a request of the world's Tenant, as an owner-internal read; never a public Read. */
export const historyOfRequest = (world: AuthWorld, requestId: string) =>
  world.database
    .inTenant(world.tenantId, (transaction) =>
      loadRequestHistory(transaction, world.tenantId, CommunicationRequestIdSchema.make(requestId)),
    )
    .pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die('the request has no history in this Tenant'),
          onSome: (record) => Effect.succeed(record),
        }),
      ),
    );

/** The issuance reference of the request at `index`, as Auth's own branded identity. */
export const issuanceRefOf = (world: AuthWorld, index = 0) =>
  PortalAuthIssuanceRefSchema.make(world.submissions[index]?.request.occurrence.occurrenceId ?? '');

/** The decision identity of a submission, or none for a conflict. */
export const decisionIdOf = (submission: PortalAuthSubmission) =>
  submission.outcome === 'DECIDED' ? submission.decisionId : submission.originalDecisionId;
