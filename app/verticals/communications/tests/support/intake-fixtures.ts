import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import { Effect, Layer, Ref, Schema } from 'effect';

import type { TransactionalMessageType } from '../../src/domain/catalog/message-type.ts';
import { SourceStateKeySchema } from '../../src/domain/catalog/vocabulary.ts';
import { MessageHandoff } from '../../src/domain/handoff/message-handoff.ts';
import type {
  PinnedHandoff,
  ProviderEvidence,
  ProviderEvidenceCase,
} from '../../src/domain/handoff/message-handoff.ts';
import { approvedCatalogLayer } from '../../src/domain/intake/message-type-catalog.ts';
import { RecipientLanguageAuthority } from '../../src/domain/intake/recipient-language.ts';
import { ProcessingScopeDeclaration } from '../../src/domain/intake/scope-declaration.ts';
import { ProcessingScopeUndeclared } from '../../src/domain/intake/scope-declaration-errors.ts';
import { SourceOccurrenceAuthority } from '../../src/domain/intake/source-authority.ts';
import { SourceOccurrenceUnavailable } from '../../src/domain/intake/source-authority-errors.ts';
import type { RecipientLanguageContext } from '../../src/domain/language/vocabulary.ts';
import { ProcessingEligibilityUnavailable } from '../../src/domain/privacy/eligibility-errors.ts';
import { ProcessingEligibilityGate } from '../../src/domain/privacy/eligibility-gate.ts';
import type {
  ProcessingEligibilityGateService,
  ProcessingEligibilityQuery,
} from '../../src/domain/privacy/eligibility-gate.ts';
import { RecipientAuthorityUnavailable } from '../../src/domain/recipient/current-gate-errors.ts';
import { RecipientCurrentGate } from '../../src/domain/recipient/current-gate.ts';
import type { RecipientCurrentGateService, RecipientGateQuery } from '../../src/domain/recipient/current-gate.ts';
import { OriginalRecipientBindingSchema } from '../../src/domain/recipient/original-binding.ts';
import type { OriginalRecipientBinding } from '../../src/domain/recipient/original-binding.ts';
import { FIXTURE_OPEN_STATE, FIXTURE_TENANT_ID } from '../unit/support/catalog-fixtures.ts';
import { processingScope } from '../unit/support/privacy-fixtures.ts';
import type { PrivacyAnswer } from '../unit/support/privacy-fixtures.ts';
import { binding, fixtureScope, TEST_GATE_CHECK_TIMEOUT } from '../unit/support/recipient-fixtures.ts';
import type { OwnerAnswer } from '../unit/support/recipient-fixtures.ts';

/**
 * TEST-ONLY wiring of the intake lane. Every source, recipient, owner answer and scope here is fictional, and every
 * double is a labelled stand-in at the edge of ANOTHER owner (source facts, recipient authority, Privacy, the Messaging
 * Adapter): it proves how Communications reacts to an answer, never that a real owner answers so. No test using these
 * doubles is delivery, Privacy or provider evidence.
 */

const decodeRequest = Schema.decodeUnknownSync(CommunicationRequestSchema, { onExcessProperty: 'error' });
const encodeBinding = Schema.encodeSync(OriginalRecipientBindingSchema);

interface ScopeInput {
  counterpartyId?: string;
  legalEntityId?: string;
  profileId?: string;
  tenantId: string;
}

export interface RequestInput {
  readonly bindings: readonly OriginalRecipientBinding[];
  readonly correlationId?: string;
  readonly counterpartyId?: string;
  readonly idempotencyKey?: string;
  readonly legalEntityId?: string | undefined;
  readonly occurrenceId?: string;
  readonly profileId?: string | undefined;
  readonly purpose?: string;
  /** Makes the request an Explicit Resend of the named original intent (#1403). */
  readonly resendOf?: { readonly originalIntentId: string; readonly reason?: string };
  readonly revision?: number;
  readonly safeReferences?: readonly { readonly key: string; readonly resourceId: string }[];
  readonly sourceModule?: string;
  readonly tenantId?: string;
}

/** A fictional committed source request as the published contract carries it. */
export const communicationRequest = (input: RequestInput): CommunicationRequest => {
  const tenantId = input.tenantId ?? FIXTURE_TENANT_ID;
  const scopeInput: ScopeInput = { tenantId };
  if (input.legalEntityId !== undefined) {
    scopeInput.legalEntityId = input.legalEntityId;
  }
  if (input.profileId !== undefined) {
    scopeInput.profileId = input.profileId;
  }
  if (input.counterpartyId !== undefined) {
    scopeInput.counterpartyId = input.counterpartyId;
  }
  const scope = fixtureScope(scopeInput);
  const key = input.idempotencyKey ?? `fixture-key-${input.occurrenceId ?? 'occurrence-1'}`;
  const ordinary = {
    idempotency: input.correlationId === undefined ? { key } : { correlationId: input.correlationId, key },
    occurrence: { occurrenceId: input.occurrenceId ?? 'fixture-occurrence-1', revision: input.revision ?? 1 },
    originalRecipients: input.bindings.map((entry) => encodeBinding({ ...entry, scope })),
    purpose: input.purpose ?? 'fixture.single',
    safeReferences: (input.safeReferences ?? []).map(({ key: referenceKey, resourceId }) => ({
      key: referenceKey,
      ref: { moduleId: 'fixture.source', resourceId, resourceType: 'fixture.order' },
    })),
    schemaVersion: 1,
    scope,
    source: { moduleKey: input.sourceModule ?? 'fixture.source' },
  };
  // an Explicit Resend names its original intent and a closed business reason; any other request carries neither (#1403)
  return decodeRequest(
    input.resendOf === undefined
      ? ordinary
      : {
          ...ordinary,
          resendOf: {
            originalIntentId: input.resendOf.originalIntentId,
            reason: input.resendOf.reason ?? 'SOURCE_APPROVED_RESEND',
          },
        },
  );
};

export const originalRecipient = (recipientId: string, contactId: string | null = `contact-${recipientId}`) =>
  binding('original-recipient', recipientId, contactId);

export const catalogOf = (...types: readonly TransactionalMessageType[]) => approvedCatalogLayer(types);

/** The source owner's Current facts, switchable by a test: its state, its latest revision, or an outage. */
export const sourceAuthorityDouble = (initial: { latestRevision?: number; state?: string } = {}) => {
  const state = {
    available: true,
    latestRevision: initial.latestRevision ?? 1,
    reads: 0,
    state: initial.state ?? FIXTURE_OPEN_STATE,
  };
  const layer = Layer.succeed(SourceOccurrenceAuthority, {
    read: (request) =>
      Effect.suspend(() => {
        state.reads += 1;
        return state.available
          ? Effect.succeed({
              latestRevision: state.latestRevision,
              occurrenceId: request.occurrence.occurrenceId,
              state: SourceStateKeySchema.make(state.state),
              tenantId: request.tenantId,
            })
          : Effect.fail(new SourceOccurrenceUnavailable({ reason: 'OWNER_UNAVAILABLE' }));
      }),
  });
  return { layer, state };
};

/** The Privacy scope of the fictional producer declaration, switchable to "no producer declared one". */
export const scopeDeclarationDouble = () => {
  const state = { declared: true };
  const layer = Layer.succeed(ProcessingScopeDeclaration, {
    declare: ({ binding: declared }) =>
      state.declared
        ? Effect.succeed(processingScope(declared.recipientRef.resourceId))
        : Effect.fail(new ProcessingScopeUndeclared({ reason: 'NO_DECLARATION' })),
  });
  return { layer, state };
};

/**
 * TEST DOUBLE of the Current recipient authority: answers by ORIGINAL contact id (changeable between calls, as an owner
 * would change), records every query and, like the real port, cannot read or return a Current contact.
 */
export const recipientOwnerDouble = (initial: Readonly<Record<string, OwnerAnswer>>) => {
  const answers = new Map(Object.entries(initial));
  const queries: RecipientGateQuery[] = [];
  const service: RecipientCurrentGateService = {
    check: (query) => {
      queries.push(query);
      const answer = answers.get(query.contact.contactRef.resourceId);
      return answer === undefined
        ? Effect.fail(new RecipientAuthorityUnavailable({ authority: 'SOURCE_OWNER' }))
        : answer(query);
    },
    checkTimeout: TEST_GATE_CHECK_TIMEOUT,
  };
  return { answers, layer: Layer.succeed(RecipientCurrentGate, service), queries };
};

/** TEST DOUBLE of the Privacy gate: answers by recipient id, changeable between calls, recording every query. */
export const privacyOwnerDouble = (initial: Readonly<Record<string, PrivacyAnswer>>) => {
  const answers = new Map(Object.entries(initial));
  const queries: ProcessingEligibilityQuery[] = [];
  const service: ProcessingEligibilityGateService = {
    check: (query) => {
      queries.push(query);
      const answer = answers.get(query.recipient.recipientRef.resourceId);
      return answer === undefined
        ? Effect.fail(new ProcessingEligibilityUnavailable({ reason: 'OWNER_UNAVAILABLE' }))
        : answer(query);
    },
    checkTimeout: TEST_GATE_CHECK_TIMEOUT,
  };
  return { answers, layer: Layer.succeed(ProcessingEligibilityGate, service), queries };
};

const acceptedAnswer = (message: PinnedHandoff): Effect.Effect<ProviderEvidenceCase> =>
  Effect.succeed({
    kind: 'ACCEPTED',
    providerKey: 'fixture-provider',
    providerRef: `fixture-ref-${message.attemptId}`,
  });

/**
 * TEST DOUBLE of the Messaging Adapter (step 22). It records every call it receives, so a test can prove that no second
 * external attempt was made, and answers with a scripted provider outcome. It is NOT provider evidence.
 */
export const handoffDouble = (
  answer: (message: PinnedHandoff) => Effect.Effect<ProviderEvidenceCase> = acceptedAnswer,
) => {
  const calls: PinnedHandoff[] = [];
  const layer = Layer.succeed(MessageHandoff, {
    handoff: (message): Effect.Effect<ProviderEvidence> => {
      calls.push(message);
      return answer(message).pipe(
        Effect.map((outcome) => ({
          attemptId: message.attemptId,
          intentId: message.intentId,
          outcome,
          tenantId: message.tenantId,
        })),
      );
    },
  });
  return { calls, layer };
};

/** The trusted recipient language, switchable by a test; by default none is established, as in production today. */
export const recipientLanguageDouble = () => {
  const ref = Ref.makeUnsafe<RecipientLanguageContext>({ kind: 'not-established' });
  const layer = Layer.succeed(RecipientLanguageAuthority, { languageOf: () => Ref.get(ref) });
  return { layer, ref };
};
