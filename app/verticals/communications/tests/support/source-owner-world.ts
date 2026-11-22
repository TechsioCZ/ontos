import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Match, Option, Ref, Result, Schema } from 'effect';

import { CommunicationRequestIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { deliveryAttempts, messageIntents } from '../../src/database/schema.ts';
import type { TransactionalMessageType } from '../../src/domain/catalog/message-type.ts';
import type { PinnedHandoff } from '../../src/domain/handoff/message-handoff.ts';
import { approvedCatalogLayer } from '../../src/domain/intake/message-type-catalog.ts';
import { RecipientLanguageAuthority } from '../../src/domain/intake/recipient-language.ts';
import { ProcessingScopeDeclaration } from '../../src/domain/intake/scope-declaration.ts';
import type { ProcessingScopeDeclarationService } from '../../src/domain/intake/scope-declaration.ts';
import { SourceOccurrenceAuthority } from '../../src/domain/intake/source-authority.ts';
import type { SourceOccurrenceAuthorityService } from '../../src/domain/intake/source-authority.ts';
import { renderMessage } from '../../src/domain/language/interpolation.ts';
import type { RecipientLanguageContext } from '../../src/domain/language/vocabulary.ts';
import { ProcessingEligibilityGate } from '../../src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityQuery } from '../../src/domain/privacy/eligibility-gate.ts';
import { RecipientCurrentGate } from '../../src/domain/recipient/current-gate.ts';
import type { RecipientCurrentGateService } from '../../src/domain/recipient/current-gate.ts';
import { HandoffStoreUnavailable, processIntentHandoff } from '../../src/handoff/process-intent-handoff.ts';
import type { ScopedRunner } from '../../src/handoff/process-intent-handoff.ts';
import { actionOwnerCall, underOwnerCall } from '../../src/integrations/owner-call.ts';
import { privacyProcessingEligibilityGateOver } from '../../src/integrations/privacy-eligibility-gate.ts';
import type { PrivacyOwnerTransport } from '../../src/integrations/privacy-eligibility-gate.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';
import { loadRequestHistory } from '../../src/services/message-history.service.ts';
import { privacyAllowed } from '../unit/support/privacy-fixtures.ts';
import type { PrivacyAnswer } from '../unit/support/privacy-fixtures.ts';
import { TEST_GATE_CHECK_TIMEOUT } from '../unit/support/recipient-fixtures.ts';
import { accessReads, nativeRuntimeClient, visibilityDouble } from './access-reads.ts';
import { documentOwnerDouble } from './document-owner-double.ts';
import type { handoffDouble } from './intake-fixtures.ts';
import { intakeRunnerOver } from './intake-runner.ts';
import type { RuntimeDatabase } from './intake-runner.ts';
import { actorWith, nextId } from './persistence.fixture.ts';
import { actorFor, domainFor, fictionalDraft, identity } from './template-fixtures.ts';

/**
 * PUBLISHED TEST-ONLY seam (`@app/communications/testing/source-owner-world`) for a SOURCE OWNER's end-to-end suite: the REAL
 * Communications owner code over native PostgreSQL as the runtime role (the public `submit-communication-request` handler
 * under the sealed registered-source-worker principal of the source module, the durable decision and intents, the
 * pre-handoff step and the authorized history Reads), with the source owner's answers plugged in as plain values.
 *
 * LABELLED DOUBLES (each stands at the edge of ANOTHER owner and proves how that edge is READ, never that it answers so):
 * - the Privacy gate answers by script per recipient (ALLOWED unless a test sets another answer); it is NOT Privacy evidence.
 *   A suite that proves an answer of the REAL Privacy owner passes `privacyOwner` instead: the world then runs the REAL
 *   Communications Privacy-gate adapter (the request it builds, the decoding of the answer and the verdict) and only the
 *   transport to Privacy's published Read is the suite's;
 * - the trusted recipient language is scripted through `languageRef`;
 * - the document owner is the in-memory double of `document-owner-double.ts`;
 * - the Messaging Adapter is `messagingAdapterDouble`, which only records the handoffs and answers what the test scripts;
 * - every Template Revision is the FICTIONAL copy the suite hands to `revisionOf`; no approved copy is implied.
 *
 * A source owner composes ITS side (its source-occurrence authority, its recipient endpoint check and its processing-scope
 * declaration) with `intakeWith`; nothing here imports or knows another owner's code.
 */

export { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
export type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
export { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
export { recoveryPolicyOf, resendPolicyOf } from '../../src/domain/catalog/message-type.ts';
export type { TransactionalMessageType } from '../../src/domain/catalog/message-type.ts';
export { buildMessageTypeRegistry, findMessageTypeByPurpose } from '../../src/domain/catalog/registry.ts';
export { CommunicationPurposeKeySchema, SourceStateKeySchema } from '../../src/domain/catalog/vocabulary.ts';
export type { PinnedHandoff, ProviderEvidenceCase } from '../../src/domain/handoff/message-handoff.ts';
export type { PrivacyOwnerQuestion, PrivacyOwnerTransport } from '../../src/integrations/privacy-eligibility-gate.ts';
export { ProcessingScopeUndeclared } from '../../src/domain/intake/scope-declaration-errors.ts';
export { SourceOccurrenceUnavailable } from '../../src/domain/intake/source-authority-errors.ts';
export { ProcessingScopeSchema } from '../../src/domain/privacy/processing-scope.ts';
export { RecipientAuthorityUnavailable } from '../../src/domain/recipient/current-gate-errors.ts';
export { RecipientGateVerdict } from '../../src/domain/recipient/current-gate.ts';
export { privacyIndeterminate, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
export { handoffDouble as messagingAdapterDouble } from './intake-fixtures.ts';
export { makeRuntimeDatabase, nativeServices } from './persistence.fixture.ts';

/** The FICTIONAL copy of one approved Template Revision a source owner's suite seeds for one type and language. */
export interface FictionalRevision {
  readonly body: string;
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
}

export interface SourceOwnerWorldOptions {
  readonly languages: readonly ('cs' | 'en')[];
  /** The Tenant language mode to set, or none to keep the default. */
  readonly mode?: 'A' | 'B' | undefined;
  /**
   * The transport to the REAL Privacy owner's published Reads, under which the REAL Communications Privacy-gate adapter
   * runs; none keeps the scripted gate (`privacyAnswers`, `privacyQueries`).
   */
  readonly privacyOwner?: PrivacyOwnerTransport | undefined;
  /** The FICTIONAL revision of a type in a language, or none when the suite seeds no copy for that type. */
  readonly revisionOf: (type: TransactionalMessageType, language: 'cs' | 'en') => Option.Option<FictionalRevision>;
  /** The approved types the catalog of the world serves. */
  readonly types: readonly TransactionalMessageType[];
}

/** What the source owner answers at the edges Communications reads it through. */
export interface SourceOwnerAnswers {
  readonly recipientGate: Pick<RecipientCurrentGateService, 'check'>;
  readonly scopeDeclaration: ProcessingScopeDeclarationService;
  readonly sourceAuthority: SourceOccurrenceAuthorityService;
}

/** The Messaging Adapter (step 22) double (`messagingAdapterDouble`): it records each pinned handoff and answers what the test scripts. */
export type MessagingAdapterDouble = ReturnType<typeof handoffDouble>;

type HistoryAccess = Parameters<typeof accessReads>[1]['access'];
const allowedHistoryAccess: HistoryAccess = {
  'communications.core.message-history-recipient-mask.list': 'allowed',
  'communications.core.message-history-recipient-mask.read': 'allowed',
  'communications.core.message-history.list': 'allowed',
  'communications.core.message-history.read': 'allowed',
};

/**
 * One Tenant with the FICTIONAL approved revisions the suite supplies, over the real Communications persistence that the
 * suite's composition root opens with `makeRuntimeDatabase`. The intake is composed afterwards with `intakeWith`, once the
 * source owner's side exists.
 */
export const makeSourceOwnerWorld = Effect.fn('CommunicationsSourceOwnerWorld.make')(function* makeWorld(
  database: RuntimeDatabase,
  options: SourceOwnerWorldOptions,
) {
  const tenantId = yield* nextId;

  yield* database.withPorts(tenantId, (templates, policies) =>
    Effect.gen(function* seed() {
      const domain = domainFor(templates);
      const actor = actorFor(null);
      for (const type of options.types) {
        for (const language of options.languages) {
          const revision = options.revisionOf(type, language);
          if (Option.isNone(revision)) {
            continue;
          }
          const prepared = yield* domain.prepare(
            fictionalDraft({
              ...identity({ channel: 'email', language, messageType: type.typeId, scope: { kind: 'tenant' } }),
              body: revision.value.body,
              optionalPlaceholders: [],
              requiredPlaceholders: [...revision.value.requiredPlaceholders],
              subject: revision.value.subject,
            }),
            actor,
          );
          yield* domain.approve(prepared.revision.revisionId, actor);
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

  const languageRef = Ref.makeUnsafe<RecipientLanguageContext>({ kind: 'not-established' });
  const privacyAnswers = new Map<string, PrivacyAnswer>();
  const privacyQueries: ProcessingEligibilityQuery[] = [];
  const languageLayer = Layer.succeed(RecipientLanguageAuthority, { languageOf: () => Ref.get(languageRef) });
  const privacyLayer =
    options.privacyOwner === undefined
      ? Layer.succeed(ProcessingEligibilityGate, {
          check: (query) => {
            privacyQueries.push(query);
            return (privacyAnswers.get(query.recipient.recipientRef.resourceId) ?? privacyAllowed)(query);
          },
          checkTimeout: TEST_GATE_CHECK_TIMEOUT,
        })
      : privacyProcessingEligibilityGateOver({ checkTimeout: TEST_GATE_CHECK_TIMEOUT }, options.privacyOwner);
  /** The step runs as the pre-handoff worker would: under the authority of an operation in progress of the Tenant. */
  const preHandoffCall = Effect.gen(function* preHandoffCall() {
    const scope = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* nextId,
      authContextRef: 'fixture:pre-handoff-worker',
      authenticationNamespaceId: 'core.staff',
      authMethod: 'session',
      principalId: yield* nextId,
      tenantId,
    }).pipe(Effect.orDie);
    return actionOwnerCall({ ...scope, correlationId: 'fixture:pre-handoff-worker' });
  });
  const documents = documentOwnerDouble();

  const scopedRunner: ScopedRunner = (program) =>
    database
      .inTenant(tenantId, (transaction) => program(transaction))
      .pipe(
        Effect.mapError((failure) =>
          Match.value(failure).pipe(
            Match.tag('HandoffStoreUnavailable', (known) => known),
            Match.orElse(() => new HandoffStoreUnavailable({ reason: 'test database' })),
          ),
        ),
      );

  /** Composes the intake over the source owner's answers: the catalog, the doubles above and the owner's three edges. */
  const intakeWith = (answers: SourceOwnerAnswers) => {
    const portsFor = (catalog: readonly TransactionalMessageType[]) =>
      Layer.mergeAll(
        approvedCatalogLayer(catalog),
        languageLayer,
        Layer.succeed(SourceOccurrenceAuthority, answers.sourceAuthority),
        Layer.succeed(ProcessingScopeDeclaration, answers.scopeDeclaration),
        Layer.succeed(RecipientCurrentGate, { ...answers.recipientGate, checkTimeout: TEST_GATE_CHECK_TIMEOUT }),
        privacyLayer,
        documents.layer,
        NodeCrypto.layer,
      );
    const runner = intakeRunnerOver(database, portsFor(options.types));
    return {
      /** The REAL handler under the sealed registered-source-worker principal of `sourceModule`, in one Core transaction. */
      submit: (request: CommunicationRequest, sourceModule: string) =>
        runner.submit(tenantId, request, undefined, sourceModule),
      /** One delivery of the pre-handoff step of an intent, with the given Messaging Adapter double (the REAL worker step). */
      step: (handoff: MessagingAdapterDouble, intentId: string) =>
        preHandoffCall.pipe(
          Effect.flatMap((call) =>
            processIntentHandoff({ intentId: MessageIntentIdSchema.make(intentId), tenantId }, scopedRunner).pipe(
              underOwnerCall(call),
            ),
          ),
          Effect.provide(Layer.mergeAll(portsFor(options.types), handoff.layer, NodeCrypto.layer)),
        ),
    };
  };

  /**
   * The pinned revision of a handoff rendered by the REAL generic renderer, its owner-rendered slot left in place for the
   * source owner to complete; none when the revision is missing or the renderer refuses it.
   */
  const renderPinned = (
    message: PinnedHandoff,
    rendering: { readonly allowedOrigins: readonly string[]; readonly ownerSlot: string },
  ) =>
    database
      .withPort(message.tenantId, (port) => port.loadRevision(message.template.revisionId))
      .pipe(
        Effect.map(
          Option.flatMap((revision) =>
            Result.getSuccess(
              renderMessage({
                contract: [{ kind: 'owner-rendered', name: rendering.ownerSlot }],
                language: message.language,
                linkPolicy: { allowedOrigins: [...rendering.allowedOrigins] },
                template: {
                  body: revision.body,
                  optionalPlaceholders: revision.optionalPlaceholders,
                  requiredPlaceholders: revision.requiredPlaceholders,
                  subject: revision.subject,
                },
                values: {},
              }),
            ),
          ),
        ),
      );

  /** The safe history record of a request of the Tenant, as an owner-internal read; never a public Read. */
  const historyOfRequest = (requestId: string) =>
    database
      .inTenant(tenantId, (transaction) =>
        loadRequestHistory(transaction, tenantId, CommunicationRequestIdSchema.make(requestId)),
      )
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die('the request has no history in this Tenant'),
            onSome: (record) => Effect.succeed(record),
          }),
        ),
      );

  /** The authorized history Reads of the Tenant, through Core's real Read lifecycle over the real owner SQL. */
  const historyReads = Effect.fn('CommunicationsSourceOwnerWorld.historyReads')(function* reads(
    access: HistoryAccess = allowedHistoryAccess,
  ) {
    const client = yield* nativeRuntimeClient;
    const handle = yield* accessReads(client, { access, tenantId });
    const visibility = visibilityDouble(() => 'VISIBLE');
    return {
      detail: (intentId: string) =>
        handle.detail({ intentId: MessageIntentIdSchema.make(intentId) }).pipe(Effect.provide(visibility.layer)),
      list: () => handle.list().pipe(Effect.provide(visibility.layer)),
    };
  });

  return {
    /** The delivery attempts of the Tenant, as the runtime role reads them. */
    attemptRows: database.inTenant(tenantId, (transaction) => transaction.select().from(deliveryAttempts)),
    /**
     * Every row of EVERY table of the `communications` schema (enumerated from the database catalog, so no table is left
     * out by a hand list) and of Core's real outbox tables, as the runtime role sees them for the Tenant.
     */
    everyStoredRow: database.everyRowOf(tenantId, {
      schemas: ['communications'],
      tables: ['core.outbox_messages', 'core.outbox_deliveries'],
    }),
    historyOfRequest,
    historyReads,
    intakeWith,
    /** The message intents of the Tenant, as the runtime role reads them. */
    intentRows: database.inTenant(tenantId, (transaction) => transaction.select().from(messageIntents)),
    languageRef,
    privacyAnswers,
    privacyQueries,
    renderPinned,
    tenantId,
  };
});
