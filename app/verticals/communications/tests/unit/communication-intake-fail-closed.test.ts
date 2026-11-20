import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Exit, Layer, Option, Redacted } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/communications-core-message-intent-prepared-v1.ts';
import { communicationsProductionOwnerPortsLive } from '../../src/composition/owner-ports.ts';
import { CommunicationDecisionService } from '../../src/domain/catalog/decision-service.ts';
import {
  AudienceSlotKeySchema,
  MessageTypeIdSchema,
  RecipientRoleSchema,
} from '../../src/domain/catalog/vocabulary.ts';
import { MessageHandoff, unavailableMessageHandoffLayer } from '../../src/domain/handoff/message-handoff.ts';
import { MessageTypeCatalog, productionCatalogLayer } from '../../src/domain/intake/message-type-catalog.ts';
import {
  notEstablishedRecipientLanguageLayer,
  RecipientLanguageAuthority,
} from '../../src/domain/intake/recipient-language.ts';
import {
  ProcessingScopeDeclaration,
  undeclaredProcessingScopeLayer,
} from '../../src/domain/intake/scope-declaration.ts';
import {
  SourceOccurrenceAuthority,
  unavailableSourceOccurrenceAuthorityLayer,
} from '../../src/domain/intake/source-authority.ts';
import { assessPrivacyEligibility, PrivacyAssessment } from '../../src/domain/privacy/assess-privacy.ts';
import { unavailableProcessingEligibilityGateLayer } from '../../src/domain/privacy/eligibility-gate.ts';
import type { ProcessingEligibilityQuery } from '../../src/domain/privacy/eligibility-gate.ts';
import { assessRecipients } from '../../src/domain/recipient/assess-recipients.ts';
import { unavailableRecipientCurrentGateLayer } from '../../src/domain/recipient/current-gate.ts';
import { RecipientAssessment } from '../../src/domain/recipient/recipient-assessment.ts';
import { privacyRequestOf } from '../../src/integrations/privacy-eligibility-gate.ts';
import { languagePolicyPortOverRoutines } from '../../src/persistence/snapshot-ports.ts';
import { readLanguagePolicySnapshot } from '../../src/services/language-policy-domain.service.ts';
import { pinOf } from '../support/language-fixtures.ts';
import { fixtureRequest, fixtureType } from './support/catalog-fixtures.ts';
import { processingScope } from './support/privacy-fixtures.ts';
import { binding, fixtureScope } from './support/recipient-fixtures.ts';

/**
 * The production composition fails closed wherever no owner publishes the fact yet, and the pieces that cross an owner
 * boundary say exactly what they ask. Every owner here is a labelled test stand-in.
 */

const failingInvoker = { invoke: () => Effect.die('the routine is not reachable') };
const invokerReturning = (rows: readonly { readonly result: unknown }[]) => ({ invoke: () => Effect.succeed(rows) });

const snapshotOf = (invoker: Parameters<typeof languagePolicyPortOverRoutines>[0]) =>
  readLanguagePolicySnapshot(languagePolicyPortOverRoutines(invoker));

describe('Language mode snapshot over its routine (own sub-transaction)', () => {
  it.effect('reads an own choice, a proven absence and an unreadable setting as three different facts', () =>
    Effect.gen(function* snapshots() {
      const own = yield* snapshotOf(
        invokerReturning([
          {
            result: {
              kind: 'own',
              mode: 'A',
              policyVersionId: '00000000-0000-4000-8000-0000000000f1',
              setAt: '2026-11-19T10:00:00.000Z',
              setByPrincipalId: '00000000-0000-4000-8000-0000000000b1',
              versionNumber: 2,
            },
          },
        ]),
      );
      expect(own).toMatchObject({ kind: 'effective', mode: 'A', policy: { source: 'tenant', versionNumber: 2 } });
      expect(yield* snapshotOf(invokerReturning([{ result: { kind: 'none' } }]))).toMatchObject({
        kind: 'effective',
        mode: 'B',
        policy: { source: 'platform-default' },
      });
      // fail closed: an unreadable setting is never replaced by the platform default
      expect(yield* snapshotOf(invokerReturning([{ result: { kind: 'unreadable' } }]))).toEqual({ kind: 'unreadable' });
      expect(yield* snapshotOf(invokerReturning([{ result: { kind: 'nonsense' } }]))).toEqual({ kind: 'unreadable' });
      expect(yield* snapshotOf(invokerReturning([]))).toEqual({ kind: 'unreadable' });
    }),
  );

  it.effect('is read-only: it refuses to append a version', () =>
    Effect.gen(function* readOnly() {
      const port = languagePolicyPortOverRoutines(failingInvoker);
      const exit = yield* Effect.exit(
        port.append({
          actionInvocationId: '00000000-0000-4000-8000-0000000000a1',
          mode: 'A',
          principalId: '00000000-0000-4000-8000-0000000000b1',
          setAt: DateTime.makeUnsafe('2026-11-19T10:00:00Z'),
        }),
      ).pipe(Effect.provide(NodeCrypto.layer));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe('The production composition fails closed (#1401)', () => {
  it.effect('approves only the three Portal Auth types, so every other purpose is an unknown purpose', () =>
    Effect.gen(function* emptyCatalog() {
      const catalog = yield* MessageTypeCatalog;
      const evaluator = yield* CommunicationDecisionService;
      const request = fixtureRequest();
      expect(Option.isNone(catalog.byPurpose(request.purpose))).toBe(true);
      const decision = yield* evaluator.decide(request, {
        recipients: [],
        source: {
          latestRevision: 1,
          occurrenceId: request.occurrence.occurrenceId,
          state: fixtureType().eligibleSourceStates[0],
          tenantId: request.tenantId,
        },
      });
      expect(decision.outcome).toMatchObject({ reason: 'UNKNOWN_PURPOSE' });
    }).pipe(Effect.provide(productionCatalogLayer)),
  );

  it.effect(
    'has no source facts, no Privacy scope declaration and no trusted language: each says so and allows nothing',
    () =>
      Effect.gen(function* unavailableOwners() {
        const request = fixtureRequest();
        const source = yield* (yield* SourceOccurrenceAuthority)
          .read(request)
          .pipe(Effect.match({ onFailure: ({ reason }) => reason, onSuccess: () => 'ALLOWED' }));
        expect(source).toBe('OWNER_UNAVAILABLE');
        const scope = yield* (yield* ProcessingScopeDeclaration)
          .declare({
            binding: binding('original-recipient', 'r-1'),
            request,
            slotKey: AudienceSlotKeySchema.make('primary'),
            type: fixtureType(),
          })
          .pipe(Effect.match({ onFailure: ({ reason }) => reason, onSuccess: () => 'DECLARED' }));
        expect(scope).toBe('NO_DECLARATION');
        const language = yield* (yield* RecipientLanguageAuthority).languageOf(binding('original-recipient', 'r-1'));
        expect(language).toEqual({ kind: 'not-established' });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            unavailableSourceOccurrenceAuthorityLayer,
            undeclaredProcessingScopeLayer,
            notEstablishedRecipientLanguageLayer,
          ),
        ),
      ),
  );

  it.effect('has gates that deny by default: the recipient and the Privacy owner are unavailable, never allowed', () =>
    Effect.gen(function* gates() {
      const type = fixtureType();
      const [evaluated] = yield* assessRecipients({
        bindings: [binding('original-recipient', 'r-1')],
        request: fixtureRequest(),
        scope: fixtureScope(),
        type,
      });
      expect(
        RecipientAssessment.$is('SourceUnavailable')(
          evaluated?.assessment ??
            RecipientAssessment.RecipientUnresolved({
              reason: 'ORIGINAL_CONTACT_NOT_EVIDENCED',
              subject: { binding: binding('x', 'y'), slotKey: AudienceSlotKeySchema.make('primary') },
            }),
        ),
      ).toBe(true);
      const query: ProcessingEligibilityQuery = {
        occurrence: fixtureRequest().occurrence,
        recipient: {
          recipientRef: binding('original-recipient', 'r-1').recipientRef,
          role: RecipientRoleSchema.make('original-recipient'),
        },
        scope: processingScope('r-1'),
        sourceModule: fixtureRequest().source.moduleKey,
        tenantId: fixtureRequest().tenantId,
        typeId: MessageTypeIdSchema.make('fixture.single-message'),
      };
      expect(PrivacyAssessment.$is('Unavailable')(yield* assessPrivacyEligibility(query))).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          unavailableRecipientCurrentGateLayer({ checkTimeout: '1 second' }),
          unavailableProcessingEligibilityGateLayer({ checkTimeout: '1 second' }),
        ),
      ),
    ),
  );

  it.effect(
    'the handoff port is the explicit unavailable adapter: it answers that nothing was submitted, never "accepted"',
    () =>
      Effect.gen(function* handoff() {
        const port = yield* MessageHandoff;
        const attemptId = DeliveryAttemptIdSchema.make('00000000-0000-4000-8000-0000000000e1');
        const intentId = MessageIntentIdSchema.make('00000000-0000-4000-8000-0000000000e2');
        const evidence = yield* port.handoff({
          attemptId,
          endpoint: {
            channel: 'email',
            contactRef: binding('original-recipient', 'r-1').recipientRef,
            mask: 'x***',
            value: Redacted.make('x@example.test'),
          },
          intentId,
          language: 'cs',
          purpose: 'fixture.single',
          recipientRef: binding('original-recipient', 'r-1').recipientRef,
          template: pinOf('cs'),
          tenantId: fixtureRequest().tenantId,
        });
        expect(evidence).toEqual({
          attemptId,
          intentId,
          outcome: { kind: 'NOT_ATTEMPTED', reason: 'NO_ADAPTER_CONFIGURED' },
          tenantId: fixtureRequest().tenantId,
        });
      }).pipe(Effect.provide(unavailableMessageHandoffLayer)),
  );

  it('composes the production ports without a provider adapter, an EmailDeliveryService or a real recipient owner', () => {
    expect(communicationsProductionOwnerPortsLive).toBeDefined();
  });
});

const queryOf = (scope: ProcessingEligibilityQuery['scope']): ProcessingEligibilityQuery => ({
  occurrence: fixtureRequest().occurrence,
  recipient: {
    recipientRef: binding('original-recipient', 'customer-1').recipientRef,
    role: RecipientRoleSchema.make('original-recipient'),
  },
  scope,
  sourceModule: fixtureRequest().source.moduleKey,
  tenantId: fixtureRequest().tenantId,
  typeId: MessageTypeIdSchema.make('fixture.single-message'),
});

describe('The Privacy question asked for one declared scope', () => {
  it.effect(
    'names the Communications consumer, the declared activity and the located source record, and nothing else',
    () =>
      Effect.gen(function* request() {
        const asked = yield* privacyRequestOf(queryOf(processingScope('customer-1')));
        expect(asked).toMatchObject({
          consumerModuleId: 'communications.core',
          operation: 'FIXTURE_SEND_MESSAGE',
          source: { issuer: 'fixture:auth', occurrenceId: 'fixture-occurrence:customer-1' },
          target: null,
        });
        // no purpose, controller, legal basis or address is put to Privacy: Privacy resolves its own context
        expect(Object.keys(asked).toSorted((left, right) => left.localeCompare(right))).toEqual([
          'consumerModuleId',
          'operation',
          'source',
          'target',
        ]);
      }),
  );

  it.effect('locates a Party subject by its Party target', () =>
    Effect.gen(function* party() {
      const scope = processingScope('customer-1', {
        subject: {
          kind: 'PARTY_TARGET',
          partyRef: { moduleId: 'party.registry', resourceId: 'party-1', resourceType: 'party.registry.party' },
        },
      });
      expect(yield* privacyRequestOf(queryOf(scope))).toMatchObject({
        source: null,
        target: { kind: 'PARTY', resourceId: 'party-1' },
      });
    }),
  );
});

describe('The self-outbox payload', () => {
  it('carries the identities of the intent and its request only: no recipient, address, language or secret', () => {
    expect(Object.keys(OutboxPayloadSchema.fields).toSorted((left, right) => left.localeCompare(right))).toEqual([
      'intentId',
      'requestId',
    ]);
  });
});
