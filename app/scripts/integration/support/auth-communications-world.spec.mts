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
import { Config, Crypto, Effect, Layer, Match, Option, Redacted, Ref, Result, Schema } from 'effect';
import { createHash, randomBytes } from 'node:crypto';

import { CommercePortalAuthRawEmailDeliveryService } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/raw-email-delivery-service.ts';
import { CommercePortalAuthIssuedFacts } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/issued-facts.ts';
import type { IssuedFactsService } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/issued-facts.ts';
import type { CommercePortalAuthRecoveryStore } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/recovery/store-service.ts';
import { CommercePortalAuthCommunicationsEmailLive } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/communications-email-delivery.ts';
import { parseCommercePortalAuthConfig } from '../../../verticals/commerce-customer-context/api/portal-auth/provider/config.ts';
import { CommercePortalAuthCommunicationStore } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/communication-store.ts';
import { protectedValueSealerLayer } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/protected-value.ts';
import { relayCommunicationRequests } from '../../../verticals/commerce-customer-context/src/portal-auth/communications/request-relay.ts';
import { makeCommercePortalAuthCommunicationStore } from '../../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-communication-store.ts';
import { makeCommercePortalAuthDatabase } from '../../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-database.ts';
import {
  communicationIssuance,
  communicationRequestOutbox,
} from '../../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-tables.ts';
import { acquireOutlivingCleanup } from '../../../packages/core-runtime/tests/support/database.ts';
import { eq, inArray } from 'drizzle-orm';
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
 * Better Auth realm callbacks, the recovery ledger, the Communications-routed delivery, the protected handoff with its sealed
 * values in Auth's own PostgreSQL store (D2), the Auth-local outbox and its relay (D1), the owner-slot completion and the
 * enrollment gateway. A callback only commits its issuance and request; the suites' flow helpers then run ONE relay tick
 * (`world.relay`), as the production relay loop does within its interval, so a request reaches Communications only from the
 * committed outbox row. Everything on the Communications side is the REAL owner code over native PostgreSQL
 * as the runtime role: the public `submit-communication-request` handler, the durable decision and intents, the pre-handoff
 * step and the history Reads.
 *
 * LABELLED DOUBLES (each stands at the edge of ANOTHER owner and proves how that edge is READ, never that it answers so):
 * - the Privacy gate answers ALLOWED/NOT_ALLOWED/INDETERMINATE by script. The Privacy owner has no supported path to bind the
 *   subject of an unverified Portal Auth account yet (see the #1406 report), so a positive answer here is NOT Privacy evidence;
 * - the pre-verification Privacy binding is the double of that missing path: `evidencing: true` yields a FICTIONAL binding;
 *   `false` is Auth's real production composition (no supported path, so no scope is declared);
 * - the trusted recipient language is scripted; Auth publishes no trusted locale source yet;
 * - the relay's transport to the public Action is in process: the request is decided by the REAL handler under the sealed
 *   registered-source-worker principal of `commerce.customer-context` (the carrier the production Outbox Worker obtains), with
 *   no HTTP gateway between them;
 * - the Messaging Adapter (step 22) renders the pinned revision with the REAL generic renderer, asks Auth's REAL owner-slot
 *   completion for the secret slot, and then "sends" into an in-memory mailbox with a scripted provider answer;
 * - the approved Czech and English COPY does not exist: every revision below is clearly FICTIONAL and labelled so.
 */

export const FICTIONAL_COPY = '[FICTIONAL TEST COPY]';
/** The FICTIONAL realm secret every Auth "process" of a world shares, exactly as the realms below use it. */
export const REALM_SECRET = 's'.repeat(64);
const AUTH_DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);
const RELAY = { leaseMillis: 30_000, leaseOwner: 'auth-world-relay', limit: 16, maxRetryMillis: 1000, retryMillis: 0 };
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
  /** Whether the double of the missing pre-verification Privacy path evidences a binding. Default: yes (labelled double). */
  readonly evidencing?: boolean;
  readonly languages?: readonly ('cs' | 'en')[];
  readonly ledgerProbe?: IssuanceLedgerProbe;
  readonly mode?: 'A' | 'B';
  /** Approved types overriding the production catalog (a fictional recovery limit, for example). Default: production. */
  readonly types?: typeof approvedMessageTypes;
}

const slotOf = portalAuthOwnerRenderedSlotOf;

/**
 * One Tenant with approved FICTIONAL Czech and English revisions of the three Portal Auth types, the Auth protected handoff
 * and the owner doubles, over the real Communications persistence.
 */
const SUBMIT_OPERATION = 'submit-communication-request';

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

  // the Auth side: one Auth "process" (its own pool, store, sealed handoff and slot completion); a realm that owns a real recovery
  // ledger installs its probe here. `restartAuth` replaces it with a fresh process over the same database (D2).
  const ledgerProbe = {
    current: options.ledgerProbe ?? ((): ReturnType<IssuanceLedgerProbe> => Effect.succeed('CURRENT')),
  } satisfies { current: IssuanceLedgerProbe };
  const openAuthProcess = Effect.gen(function* openProcess() {
    const configuration = yield* parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* AUTH_DATABASE_URL),
      COMMERCE_PORTAL_AUTH_SECRET: REALM_SECRET,
      COMMERCE_PORTAL_AUTH_URL: PORTAL_ORIGIN,
    });
    const authDatabase = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
    const store = makeCommercePortalAuthCommunicationStore(authDatabase.executor);
    const storeLayers = Layer.merge(
      Layer.succeed(CommercePortalAuthCommunicationStore, store),
      protectedValueSealerLayer(configuration.secret).pipe(Layer.provide(NodeCrypto.layer)),
    );
    const processHandoff = yield* CommercePortalAuthProtectedHandoff.pipe(
      Effect.provide(protectedHandoffLayer((held) => ledgerProbe.current(held)).pipe(Layer.provide(storeLayers))),
    );
    const processCompletion = yield* CommercePortalAuthOwnerSlotCompletion.pipe(
      Effect.provide(
        ownerSlotCompletionLayer.pipe(Layer.provide(Layer.succeed(CommercePortalAuthProtectedHandoff, processHandoff))),
      ),
    );
    return { authDatabase, completion: processCompletion, handoff: processHandoff, store };
  });
  const auth = { process: yield* openAuthProcess };
  // the rows this world's Tenant left in the shared realm database are removed after it, whatever happened
  const firstProcess = auth.process;
  yield* Effect.addFinalizer(() =>
    firstProcess.authDatabase.executor
      .select({ issuanceRef: communicationRequestOutbox.issuanceRef })
      .from(communicationRequestOutbox)
      .where(eq(communicationRequestOutbox.tenantId, tenantId))
      .pipe(
        Effect.flatMap((rows) => {
          const refs = rows.map(({ issuanceRef }) => issuanceRef);
          return refs.length === 0
            ? Effect.void
            : firstProcess.authDatabase.executor
                .delete(communicationRequestOutbox)
                .where(inArray(communicationRequestOutbox.issuanceRef, refs))
                .pipe(
                  Effect.andThen(
                    firstProcess.authDatabase.executor
                      .delete(communicationIssuance)
                      .where(inArray(communicationIssuance.issuanceRef, refs)),
                  ),
                );
        }),
        Effect.ignore,
      ),
  );
  const restartAuth = openAuthProcess.pipe(
    Effect.tap((fresh) =>
      Effect.sync(() => {
        auth.process = fresh;
      }),
    ),
    Effect.asVoid,
  );
  const { handoff } = auth.process;
  const binding = yield* CommercePortalAuthPreVerificationPrivacyBinding.pipe(
    Effect.provide(
      options.evidencing === false
        ? unsupportedPreVerificationPrivacyBindingLayer
        : Layer.succeed(CommercePortalAuthPreVerificationPrivacyBinding, {
            // LABELLED DOUBLE of the Privacy path that does not exist: a FICTIONAL binding, never Privacy evidence
            bind: (issuance) =>
              Effect.succeed({
                bindingRef: `fictional-binding:${issuance.issuanceRef}`,
                purposeVersion: 'fictional-v1',
              }),
          }),
    ),
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
        const currentness = yield* auth.process.handoff
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
        const address = yield* originalEndpointOf(auth.process.handoff, {
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
    declare: ({ binding: recipientBinding, request, type }) =>
      Effect.gen(function* declareScope() {
        const issuance = yield* auth.process.handoff
          .issuanceOf(decodeIssuanceRef(request.occurrence.occurrenceId))
          .pipe(Effect.mapError(() => new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' })));
        if (Option.isNone(issuance)) {
          return yield* new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' });
        }
        const { bindingRef, purposeVersion } = yield* binding
          .bind(issuance.value)
          .pipe(Effect.mapError(() => new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' })));
        return decodeScope({
          catalogPurposeRef: type.privacyPurposeRefs[0],
          channel: 'email',
          controllerRef: 'fictional-controller',
          dataCategoryRefs: ['fictional:contact'],
          operation: 'FICTIONAL_SEND_AUTH_MESSAGE',
          processingScopeRef: { scopeId: bindingRef, scopeType: 'fictional.processing-scope' },
          purposeRef: 'fictional-purpose',
          purposeVersionId: purposeVersion,
          recipientRefs: ['fictional.communications'],
          subject: {
            kind: 'SOURCE_ASSERTED',
            source: {
              issuer: 'fictional:portal-auth',
              namespace: 'fictional-issuances',
              occurrenceId: bindingRef,
              recordId: recipientBinding.recipientRef.resourceId,
              recordType: 'fictional-portal-account',
              routeRef: 'fictional:route',
            },
          },
        });
      }),
  });
  const languageLayer = Layer.succeed(RecipientLanguageAuthority, { languageOf: () => Ref.get(language) });
  const privacyLayer = Layer.succeed(ProcessingEligibilityGate, {
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
      const values = yield* auth.process.completion.complete({
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

  /** The relay's transport, in process: the REAL handler under the sealed registered-source-worker principal of the source module. */
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
            Layer.succeed(CommercePortalAuthTrustedScope, { current: Effect.succeed({ tenantId }) }),
            Layer.succeed(CommercePortalAuthIssuedFacts, delegatingStore),
            cryptoLive,
          ),
        ),
      ),
    ),
  );
  /** ONE relay tick over the Auth-local outbox of the current Auth process, through the world's transport. */
  const relay = Effect.suspend(() =>
    relayCommunicationRequests({ ...RELAY, tenantId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(CommercePortalAuthCommunicationStore, auth.process.store),
          Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, submitter),
        ),
      ),
    ),
  );

  return {
    binding,
    get completion() {
      return auth.process.completion;
    },
    database,
    documents,
    get handoff() {
      return auth.process.handoff;
    },
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
    /** The Auth-local outbox rows of this world's Tenant, as Auth's runtime role reads them. */
    outboxRows: Effect.suspend(() =>
      auth.process.authDatabase.executor
        .select()
        .from(communicationRequestOutbox)
        .where(eq(communicationRequestOutbox.tenantId, tenantId)),
    ),
    read: <Row,>(
      select: (
        transaction: Parameters<Parameters<typeof database.inTenant>[1]>[0],
      ) => Effect.Effect<readonly Row[], unknown>,
    ) => database.inTenant(tenantId, select),
    recoveryStore,
    relay,
    restartAuth,
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
