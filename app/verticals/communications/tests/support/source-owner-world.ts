import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Match, Option, Ref, Result, Schema } from 'effect';

import { CommunicationRequestIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { deliveryAttempts, messageIntents } from '../../src/database/schema.ts';
import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import type { TransactionalMessageType } from '../../src/domain/catalog/message-type.ts';
import type { PinnedHandoff } from '../../src/domain/handoff/message-handoff.ts';
import { approvedCatalogLayer } from '../../src/domain/intake/message-type-catalog.ts';
import { RecipientLanguageAuthority } from '../../src/domain/intake/recipient-language.ts';
import { ProcessingScopeDeclaration } from '../../src/domain/intake/scope-declaration.ts';
import type { ProcessingScopeDeclarationService } from '../../src/domain/intake/scope-declaration.ts';
import { renderMessage } from '../../src/domain/language/interpolation.ts';
import type { RecipientLanguageContext } from '../../src/domain/language/vocabulary.ts';
import { communicationsOwnerPortsOver } from '../../src/composition/owner-ports.ts';
import { HandoffStoreUnavailable, processIntentHandoff } from '../../src/handoff/process-intent-handoff.ts';
import type { ScopedRunner } from '../../src/handoff/process-intent-handoff.ts';
import { actionOwnerCall, underOwnerCall } from '../../src/integrations/owner-call.ts';
import type { PortalAuthOwnerTransport } from '../../src/integrations/portal-auth-owner.ts';
import type { PrivacyOwnerTransport } from '../../src/integrations/privacy-eligibility-gate.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';
import { pinnedTemplateText } from '../../src/services/template-revision-domain.service.ts';
import { loadRequestHistory } from '../../src/services/message-history.service.ts';
import { accessReads, nativeRuntimeClient, visibilityDouble } from './access-reads.ts';
import type { handoffDouble } from './intake-fixtures.ts';
import { intakeRunnerOver } from './intake-runner.ts';
import type { RuntimeDatabase } from './intake-runner.ts';
import { actorWith, nextId } from './persistence.fixture.ts';
import { actorFor, domainFor, fictionalDraft, identity } from './template-fixtures.ts';

/**
 * PUBLISHED TEST-ONLY seam (`@app/communications/testing/source-owner-world`) for a SOURCE OWNER's end-to-end suite: the REAL
 * Communications owner code over native PostgreSQL as the runtime role (the public `submit-communication-request` handler
 * under the sealed registered-source-worker principal of the source module, the durable decision and intents, the
 * pre-handoff step and the authorized history Reads).
 *
 * The OWNER PORTS ARE THE PRODUCTION COMPOSITION (`communicationsOwnerPortsOver`, T1-04): the catalog, the source-occurrence
 * authority and the recipient gate of Portal Auth (the live adapters over Auth's published Read), the Privacy gate over
 * Privacy's published Reads, the unavailable document owner and the production recipient language. A suite supplies only how
 * each owner is REACHED (the two transports) and nothing replaces what is asked or how an answer is read: this seam accepts no
 * source-authority, recipient-gate or Privacy-gate port, so a test cannot stand one in.
 *
 * LABELLED DOUBLES that remain (each at the edge of ANOTHER owner and open owner gates, never a claim that the owner answers so):
 * - the producer's Privacy-scope declaration (`producerScope`): production deliberately declares NONE (#1396 J: the source
 *   producer declares it and the Privacy owner has not confirmed the values), so a suite that proves the positive path supplies
 *   the declaration the SOURCE would make;
 * - the trusted recipient language, only when a suite asks for `recipientLanguage: 'LABELLED_DOUBLE'`: no owner publishes one
 *   (R-D12), so production establishes none and the language is `cs`;
 * - the Messaging Adapter is `messagingAdapterDouble` (step 22), which only records the handoffs and answers what the test scripts;
 * - every Template Revision is the FICTIONAL copy the suite hands to `revisionOf`; no approved copy is implied (R-D1).
 *
 * `ownerPortSources` states, per port, whether it came from production or is a labelled double, so a suite can fail on a
 * substitution.
 */

export { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
export type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
export { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
export {
  PORTAL_AUTH_DEFAULT_COPY_APPROVAL,
  portalAuthDefaultCopy,
} from '../../src/domain/catalog/portal-auth-copy-draft.ts';
export { recoveryPolicyOf, resendPolicyOf } from '../../src/domain/catalog/message-type.ts';
export type { TransactionalMessageType } from '../../src/domain/catalog/message-type.ts';
export { buildMessageTypeRegistry, findMessageTypeByPurpose } from '../../src/domain/catalog/registry.ts';
export { CommunicationPurposeKeySchema, SourceStateKeySchema } from '../../src/domain/catalog/vocabulary.ts';
export type { PinnedHandoff, ProviderEvidenceCase } from '../../src/domain/handoff/message-handoff.ts';
export type { PortalAuthOwnerTransport } from '../../src/integrations/portal-auth-owner.ts';
export type { PrivacyOwnerQuestion, PrivacyOwnerTransport } from '../../src/integrations/privacy-eligibility-gate.ts';
export { ProcessingScopeUndeclared } from '../../src/domain/intake/scope-declaration-errors.ts';
export { SourceOccurrenceUnavailable } from '../../src/domain/intake/source-authority-errors.ts';
export { ProcessingScopeSchema } from '../../src/domain/privacy/processing-scope.ts';
export { RecipientAuthorityUnavailable } from '../../src/domain/recipient/current-gate-errors.ts';
export { RecipientGateVerdict } from '../../src/domain/recipient/current-gate.ts';
export { handoffDouble as messagingAdapterDouble } from './intake-fixtures.ts';
export { makeRuntimeDatabase, nativeServices } from './persistence.fixture.ts';

/** The FICTIONAL copy of one approved Template Revision a source owner's suite seeds for one type and language. */
export interface FictionalRevision {
  readonly body: string;
  readonly requiredPlaceholders: readonly string[];
  readonly subject: string;
}

export interface SourceOwnerWorldOptions {
  /**
   * The languages whose FICTIONAL revision the Tenant prepares and activates. A type and language NOT listed has no text:
   * only a revision an administrator prepared and activated is ever used, so its message is not sent (R-D1).
   */
  readonly languages: readonly ('cs' | 'en')[];
  /** The Tenant language mode to set, or none to keep the default. */
  readonly mode?: 'A' | 'B' | undefined;
  /** How the PRODUCTION Privacy-gate adapter reaches the Privacy owner's published Reads. Required: there is no scripted gate. */
  readonly privacyOwner: PrivacyOwnerTransport;
  /**
   * Where the recipient language comes from. `PRODUCTION` (default): no owner publishes a trusted language, so none is
   * established and `cs` applies. `LABELLED_DOUBLE`: the suite scripts it through `setTrustedLanguage`.
   */
  readonly recipientLanguage?: 'LABELLED_DOUBLE' | 'PRODUCTION' | undefined;
  /**
   * The languages the Tenant TOOK OVER and then stopped: the FICTIONAL revision is activated and deactivated again, so the
   * identity has no text in force and fails closed.
   */
  readonly retiredLanguages?: readonly ('cs' | 'en')[];
  /** The FICTIONAL revision of a type in a language, or none when the suite seeds no copy for that type. */
  readonly revisionOf: (type: TransactionalMessageType, language: 'cs' | 'en') => Option.Option<FictionalRevision>;
  /** The approved types the catalog of the world serves. */
  readonly types: readonly TransactionalMessageType[];
}

/**
 * What a source owner supplies to compose the intake on the PRODUCTION owner ports: how its published Read is reached and the
 * scope its producer declares (a labelled double: production declares none yet). It supplies no port of the decision itself.
 */
export interface SourceOwnerSeams {
  readonly portalAuth: PortalAuthOwnerTransport;
  readonly producerScope: ProcessingScopeDeclarationService;
}

/** Where each owner port of the intake came from. Anything but `PRODUCTION` is a labelled double. */
export interface OwnerPortSources {
  readonly catalog: 'OVERRIDDEN_FOR_THE_CASE' | 'PRODUCTION';
  readonly documentOwner: 'PRODUCTION_UNAVAILABLE_FORM';
  readonly privacyGate: 'PRODUCTION_ADAPTER_OVER_PRIVACY_TRANSPORT';
  readonly recipientGate: 'PRODUCTION_ADAPTER_OVER_AUTH_TRANSPORT';
  readonly recipientLanguage: 'LABELLED_DOUBLE' | 'PRODUCTION_NOT_ESTABLISHED';
  readonly scopeDeclaration: 'LABELLED_PRODUCER_DOUBLE';
  readonly sourceAuthority: 'PRODUCTION_ADAPTER_OVER_AUTH_TRANSPORT';
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
 * suite's composition root opens with `makeRuntimeDatabase`. The intake is composed afterwards with `intakeOnProduction`, once the
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
        for (const language of [...options.languages, ...(options.retiredLanguages ?? [])]) {
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
          if (options.retiredLanguages?.includes(language) === true) {
            yield* domain.deactivate(prepared.revision.revisionId, 'Fictional retirement of the own text', actor);
          }
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

  const languageIsDouble = options.recipientLanguage === 'LABELLED_DOUBLE';
  const languageRef = Ref.makeUnsafe<RecipientLanguageContext>({ kind: 'not-established' });
  /** The trusted recipient language of the LABELLED DOUBLE; a suite on the production language has no such source and dies here. */
  const setTrustedLanguage = (language: 'cs' | 'en') =>
    languageIsDouble
      ? Ref.set(languageRef, { kind: 'trusted', language })
      : Effect.die('No owner publishes a trusted recipient language: ask for recipientLanguage LABELLED_DOUBLE');
  const ownerPortSources = {
    catalog: options.types === approvedMessageTypes ? 'PRODUCTION' : 'OVERRIDDEN_FOR_THE_CASE',
    documentOwner: 'PRODUCTION_UNAVAILABLE_FORM',
    privacyGate: 'PRODUCTION_ADAPTER_OVER_PRIVACY_TRANSPORT',
    recipientGate: 'PRODUCTION_ADAPTER_OVER_AUTH_TRANSPORT',
    recipientLanguage: languageIsDouble ? 'LABELLED_DOUBLE' : 'PRODUCTION_NOT_ESTABLISHED',
    scopeDeclaration: 'LABELLED_PRODUCER_DOUBLE',
    sourceAuthority: 'PRODUCTION_ADAPTER_OVER_AUTH_TRANSPORT',
  } as const satisfies OwnerPortSources;
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

  /**
   * Composes the intake on the PRODUCTION owner ports over the two transports the source owner supplies, plus the labelled
   * producer scope. The catalog is the production one unless the case overrides the approved types.
   */
  const intakeOnProduction = (seams: SourceOwnerSeams) => {
    const portsFor = (catalog: readonly TransactionalMessageType[]) =>
      Layer.mergeAll(
        communicationsOwnerPortsOver({ portalAuth: seams.portalAuth, privacy: options.privacyOwner }),
        // a case that overrides the approved types replaces exactly the catalog; the production one is untouched otherwise
        ...(catalog === approvedMessageTypes ? [] : [approvedCatalogLayer(catalog)]),
        ...(languageIsDouble
          ? [Layer.succeed(RecipientLanguageAuthority, { languageOf: () => Ref.get(languageRef) })]
          : []),
        Layer.succeed(ProcessingScopeDeclaration, seams.producerScope),
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
      .withPort(message.tenantId, (port) => pinnedTemplateText(port, message.template))
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

  /**
   * The Tenant's authorised user REPLACING the text of one exact type and language, tenant-wide, the way the prepare and
   * activate Actions do: a new own revision, prepared and activated under that person's principal.
   */
  const replaceTemplate = (
    messageType: string,
    language: 'cs' | 'en',
    revision: FictionalRevision,
    principalId: string,
  ) =>
    database.withPort(tenantId, (port) =>
      Effect.gen(function* replace() {
        const domain = domainFor(port);
        const actor = { ...actorFor(null), actionInvocationId: yield* nextId, principalId };
        const prepared = yield* domain.prepare(
          fictionalDraft({
            ...identity({ channel: 'email', language, messageType, scope: { kind: 'tenant' } }),
            body: revision.body,
            optionalPlaceholders: [],
            requiredPlaceholders: [...revision.requiredPlaceholders],
            subject: revision.subject,
          }),
          actor,
        );
        return yield* domain.approve(prepared.revision.revisionId, actor);
      }),
    );

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
    intakeOnProduction,
    /** The message intents of the Tenant, as the runtime role reads them. */
    intentRows: database.inTenant(tenantId, (transaction) => transaction.select().from(messageIntents)),
    ownerPortSources,
    renderPinned,
    replaceTemplate,
    setTrustedLanguage,
    tenantId,
  };
});
