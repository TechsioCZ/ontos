import type {
  PrivacyOwnerCoverageRequest,
  PrivacyOwnerCoverageResponse,
} from '@app/communications/api/privacy-owner-coverage';
import { assessCommunicationsOwnerCoverage } from '@app/communications/privacy-owner/coverage';
import { INVENTORY_CATEGORY_IDS, scopePartRefs } from '@app/communications/privacy-owner/inventory';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { Cause, DateTime, Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { runOwnerInventory } from '../../src/api/owner-inventory.read.ts';
import {
  activityWith,
  capabilitiesOf,
  coverageEntry,
  fixtureTenantId as tenantId,
  lookupRequestOf,
  plainRequestOf,
} from '../support/owner-inventory-communications.fixture.ts';

/**
 * [#1410 AC-14 AC-15, scenarios "Communications neni dostupna v dotazovane composition" and "Doklad jineho vlastnika
 * nepotvrdi vysledek Communications"] Privacy's public owner-inventory Read now asks Communications for data-level coverage
 * through Core's governed call. The owner is a labelled double of the SDK call here; the real owner over PostgreSQL is
 * proven in the integration suite. Every value is FICTIONAL.
 */

const observedAt = '2026-11-19T10:00:00.000Z';
const foreignTenant = '00000000-0000-4000-8000-0000000000ff';
const OWNER = 'communications.core';

const communicationsActivity = activityWith(
  tenantId,
  scopePartRefs.map((scope) => coverageEntry(tenantId, OWNER, scope)),
);

interface ObservationOverride {
  readonly coverageStatus: 'COMPLETE' | 'PARTIAL';
  readonly found?: readonly string[];
  readonly unresolvedReason?: string;
}

const observationsOf = (overrides: Partial<Record<string, ObservationOverride>> = {}) =>
  INVENTORY_CATEGORY_IDS.map((category) => {
    const override = overrides[category];
    const base = {
      category,
      evidenceRefs: [`FICTIONAL-evidence/${category}`],
      foundContentRefs: [...(override?.found ?? [])],
      observedAt,
    };
    return override?.unresolvedReason === undefined
      ? { ...base, coverageStatus: override?.coverageStatus ?? 'COMPLETE' }
      : { ...base, coverageStatus: override.coverageStatus, unresolvedReason: override.unresolvedReason };
  });

/** What a real owner would answer for the exact request it was asked, with the given per-category observations. */
const answerFor = (
  request: PrivacyOwnerCoverageRequest,
  observations = observationsOf(),
  scopeOverrides: Partial<PrivacyOwnerCoverageResponse['coverage']['scope']> = {},
): PrivacyOwnerCoverageResponse => ({
  configuration: [],
  contribution: Option.none(),
  coverage: assessCommunicationsOwnerCoverage({
    assessedAt: observedAt,
    evidenceRefs: ['FICTIONAL-evidence'],
    observations,
    scope: { ...request.scope, ...scopeOverrides },
  }),
  externalCopies: [],
  ownerCapability: OWNER,
  ownerMutationBoundary: 'NO_AUTOMATIC_OR_DESTRUCTIVE_OWNER_OPERATION',
});

const ok = (value: PrivacyOwnerCoverageResponse): CallOutcome<PrivacyOwnerCoverageResponse> => ({ _tag: 'Ok', value });
const entryOf = (answer: Effect.Success<ReturnType<typeof runOwnerInventory>>) =>
  answer.result.entries.find((entry) => entry.moduleId === OWNER);
const reasonOf = (answer: Effect.Success<ReturnType<typeof runOwnerInventory>>) => entryOf(answer)?.reason ?? '';

const answerWith = (state?: 'active' | 'read_only' | 'suspended') =>
  runOwnerInventory(
    lookupRequestOf(tenantId, 'customer-1'),
    capabilitiesOf(communicationsActivity, tenantId, (request) => Effect.succeed(ok(answerFor(request))), state)
      .capabilities,
  );

describe('Privacy owner inventory with Communications coverage', () => {
  /**
   * FROZEN recording of the behavior at the base commit 3b729b184 (#1402), written down as literals and NOT derived from the
   * function under test: the base Read answered these two owners UNCHECKED with no observation, whatever the request said.
   */
  const baseAnswerForOtherOwners = {
    activityRef: 'activity-1',
    complete: false,
    entries: [
      {
        moduleId: 'party.registry',
        observedAt: null,
        reason: null,
        requiredByCoverageRefs: ['party.registry.record'],
        resourceRefs: [],
        status: 'UNCHECKED',
      },
      {
        moduleId: 'commerce.customer-context',
        observedAt: null,
        reason: null,
        requiredByCoverageRefs: ['commerce.customer-context.record'],
        resourceRefs: [],
        status: 'UNCHECKED',
      },
    ],
    tenantId,
  } as const;

  it.effect('answers other owners exactly as the base commit did and asks nobody when no subject lookup is named', () =>
    Effect.gen(function* unchangedForOtherOwners() {
      const other = activityWith(tenantId, [
        coverageEntry(tenantId, 'party.registry', 'party-record'),
        coverageEntry(tenantId, 'commerce.customer-context', 'profile'),
      ]);
      const { asked, capabilities } = capabilitiesOf(other, tenantId, () =>
        Effect.succeed({ _tag: 'Unavailable', reason: 'must not be asked', retryable: true }),
      );
      const answer = yield* runOwnerInventory(plainRequestOf(tenantId), capabilities);
      expect(answer.result).toEqual(baseAnswerForOtherOwners);
      // a lookup for an activity that declares no Communications scope asks nobody either, and answers the same
      const withLookup = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
      expect(withLookup.result).toEqual(baseAnswerForOtherOwners);
      expect(asked).toEqual([]);
    }),
  );

  it.effect(
    'documents the one deliberate change: an activity declaring Communications was MISSING at the base and is UNCHECKED now',
    () =>
      Effect.gen(function* missingBecomesUnchecked() {
        const { capabilities } = capabilitiesOf(communicationsActivity, tenantId, () =>
          Effect.succeed({ _tag: 'Unavailable', reason: 'must not be asked', retryable: true }),
        );
        const answer = yield* runOwnerInventory(plainRequestOf(tenantId), capabilities);
        // the base composition did not list the owner, so the base answer for this very activity was status MISSING; the
        // owner is now listed (it publishes a coverage contract) and, not being asked, is UNCHECKED: still never NO_DATA
        const baseStatus = 'MISSING';
        expect(entryOf(answer)?.status).toBe('UNCHECKED');
        expect(entryOf(answer)?.status).not.toBe(baseStatus);
        expect(answer.result.complete).toBe(false);
      }),
  );

  it.effect(
    'names the module state UNKNOWN when no Module State Gate fact is in the Read context, and uses a real fact when there is one',
    () =>
      Effect.gen(function* moduleState() {
        const unknown = yield* answerWith();
        expect(entryOf(unknown)?.status).toBe('NO_DATA');
        expect(reasonOf(unknown)).toContain('MODULE_STATE_UNKNOWN_ADMITTED_BY_THE_GOVERNED_CALL');
        // a real gate fact replaces the unknown: nothing is named unknown, and a state that refuses is DISABLED
        expect(reasonOf(yield* answerWith('read_only'))).not.toContain('MODULE_STATE_UNKNOWN');
        expect(entryOf(yield* answerWith('active'))?.status).toBe('NO_DATA');
        expect(entryOf(yield* answerWith('suspended'))?.status).toBe('DISABLED');
      }),
  );

  it.effect('reports Communications as UNCHECKED, never MISSING or NO_DATA, while no subject lookup was asked', () =>
    Effect.gen(function* unchecked() {
      const { asked, capabilities } = capabilitiesOf(communicationsActivity, tenantId, () =>
        Effect.succeed({ _tag: 'Unavailable', reason: 'x', retryable: true }),
      );
      const answer = yield* runOwnerInventory(plainRequestOf(tenantId), capabilities);
      expect(entryOf(answer)?.status).toBe('UNCHECKED');
      expect(answer.result.complete).toBe(false);
      expect(asked).toEqual([]);
    }),
  );

  it.effect('proves NO_DATA only from an owner answer that evidences every requested scope part completely', () =>
    Effect.gen(function* complete() {
      const { asked, capabilities } = capabilitiesOf(communicationsActivity, tenantId, (request) =>
        Effect.succeed(ok(answerFor(request))),
      );
      const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
      expect(entryOf(answer)?.status).toBe('NO_DATA');
      expect(answer.result.complete).toBe(true);
      // the question is exactly what the activity declares, for the exact confirmed subject, in the trusted tenant
      expect(asked).toHaveLength(1);
      expect(asked[0]?.scope).toMatchObject({
        controllerRef: 'FICTIONAL-controller',
        ownerCapability: OWNER,
        subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-subject-1' },
        tenantId,
        trustedLookupRefs: ['lookup-customer-1'],
      });
      expect(new Set(asked[0]?.scope.requestedScopePartRefs)).toEqual(new Set(scopePartRefs));
    }),
  );

  it.effect(
    'reports FOUND with the owner references and PARTIAL with its reason, and never completes an incomplete scope',
    () =>
      Effect.gen(function* foundAndPartial() {
        const found = capabilitiesOf(communicationsActivity, tenantId, (request) =>
          Effect.succeed(
            ok(
              answerFor(
                request,
                observationsOf({
                  REQUEST_DECISION_INTENT: { coverageStatus: 'COMPLETE', found: ['communications.core.request:r1'] },
                }),
              ),
            ),
          ),
        );
        const foundAnswer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), found.capabilities);
        expect(entryOf(foundAnswer)).toMatchObject({
          resourceRefs: ['communications.core.request:r1'],
          status: 'FOUND',
        });
        const partial = capabilitiesOf(communicationsActivity, tenantId, (request) =>
          Effect.succeed(
            ok(
              answerFor(
                request,
                observationsOf({
                  PROVIDER_COPY_WORKING_COPY_PROTECTION: {
                    coverageStatus: 'PARTIAL',
                    unresolvedReason: 'BACKUP_AND_RECOVERY_COPIES_NOT_OBSERVABLE_BY_OWNER',
                  },
                }),
              ),
            ),
          ),
        );
        const partialAnswer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), partial.capabilities);
        expect(entryOf(partialAnswer)?.status).toBe('PARTIAL');
        expect(reasonOf(partialAnswer)).toContain('BACKUP_AND_RECOVERY_COPIES_NOT_OBSERVABLE_BY_OWNER');
        expect(partialAnswer.result.complete).toBe(false);
      }),
  );

  it.effect('never turns an unavailable, refused, absent or rejected owner into NO_DATA: the part stays explicit', () =>
    Effect.gen(function* unavailable() {
      const outcomes: readonly (readonly [CallOutcome<PrivacyOwnerCoverageResponse>, string])[] = [
        [{ _tag: 'Unavailable', reason: 'module not reachable', retryable: true }, 'OWNER_UNAVAILABLE'],
        [{ _tag: 'Forbidden', reason: 'denied' }, 'OWNER_READ_FORBIDDEN'],
        [{ _tag: 'NotFound', reason: 'no scope' }, 'OWNER_SCOPE_NOT_FOUND'],
        [{ _tag: 'Rejected', code: 'invalid', reason: 'rejected' }, 'OWNER_REJECTED_THE_REQUEST'],
      ];
      for (const [outcome, reason] of outcomes) {
        const { capabilities } = capabilitiesOf(communicationsActivity, tenantId, () => Effect.succeed(outcome));
        const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
        expect(entryOf(answer)?.status).toBe('UNAVAILABLE');
        expect(reasonOf(answer)).toBe(reason);
        expect(answer.result.complete).toBe(false);
      }
    }),
  );

  it.effect(
    'does not accept an answer to another subject, controller, scope or tenant as Communications evidence',
    () =>
      Effect.gen(function* mismatched() {
        const other: readonly Partial<PrivacyOwnerCoverageResponse['coverage']['scope']>[] = [
          { subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'FICTIONAL-subject-2' } },
          { controllerRef: 'FICTIONAL-other-controller' },
          { requestedScopeRef: 'FICTIONAL-other-scope' },
          { trustedLookupRefs: ['lookup-2'] },
          { requestedScopePartRefs: scopePartRefs.slice(1) },
          { ownerCapability: 'commerce.tax' },
        ];
        for (const scope of other) {
          const { capabilities } = capabilitiesOf(communicationsActivity, tenantId, (request) =>
            Effect.succeed(ok(answerFor(request, observationsOf(), scope))),
          );
          const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
          expect(entryOf(answer)?.status).not.toBe('NO_DATA');
          expect(entryOf(answer)?.status).toBe('UNAVAILABLE');
        }
      }),
  );

  it.effect(
    'asks nothing when the activity declares only some of the owner scopes: that is not a question the owner publishes',
    () =>
      Effect.gen(function* notAskable() {
        const partial = activityWith(
          tenantId,
          scopePartRefs.slice(0, 3).map((scope) => coverageEntry(tenantId, OWNER, scope)),
        );
        const { asked, capabilities } = capabilitiesOf(partial, tenantId, (request) =>
          Effect.succeed(ok(answerFor(request))),
        );
        const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
        expect(asked).toEqual([]);
        expect(entryOf(answer)?.status).toBe('UNAVAILABLE');
        expect(reasonOf(answer)).toBe('ACTIVITY_SCOPE_IS_NOT_A_QUESTION_THE_OWNER_PUBLISHES');
      }),
  );

  it.effect(
    'carries the owner contribution, external copies and configuration gaps exactly as the owner answered them',
    () =>
      Effect.gen(function* answerDetail() {
        const contribution = {
          completion: 'INCOMPLETE' as const,
          decisions: [
            {
              category: 'REQUEST_DECISION_INTENT' as const,
              contentRef: 'communications.core.request:r1',
              outcome: 'INCLUDE' as const,
              reason: 'OWN_RECORD_OF_THE_SUBJECT',
            },
          ],
          exclusions: [{ reason: 'AUTH_SECRET_OR_PROOF_NEVER_KEPT', scopeRef: 'communications.core.auth' }],
          includedContentRefs: ['communications.core.request:r1'],
          right: 'ACCESS' as const,
          unresolvedCategories: ['PROVIDER_COPY_WORKING_COPY_PROTECTION' as const],
        };
        const copy = {
          firstObservedAt: DateTime.makeUnsafe('2026-11-01T00:00:00.000Z'),
          holderRef: 'step-22-provider:fixture',
          lastObservedAt: DateTime.makeUnsafe('2026-11-02T00:00:00.000Z'),
          providerSideDispositionEvidence: 'NOT_HELD_BY_COMMUNICATIONS' as const,
          relationship: 'HISTORICAL_TRANSPORT' as const,
        };
        const configuration = [
          {
            category: 'REQUEST_DECISION_INTENT' as const,
            gapInputs: [{ input: 'RETENTION_RULE_IDENTITY_VERSION', owner: 'PRIVACY_OWNER' }],
            state: 'CONFIGURATION_GAP' as const,
          },
        ];
        const rich = capabilitiesOf(communicationsActivity, tenantId, (request) =>
          Effect.succeed(
            ok({
              ...answerFor(request),
              configuration,
              contribution: Option.some(contribution),
              externalCopies: [copy],
            }),
          ),
        );
        const answer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), rich.capabilities);
        expect(entryOf(answer)).toMatchObject({
          configuration,
          contribution,
          externalCopies: [
            { ...copy, firstObservedAt: '2026-11-01T00:00:00.000Z', lastObservedAt: '2026-11-02T00:00:00.000Z' },
          ],
        });
        // an answer to another scope than the one asked brings none of it along: it is not the owner's answer to this question
        const foreign = capabilitiesOf(communicationsActivity, tenantId, (request) =>
          Effect.succeed(
            ok({
              ...answerFor(request, observationsOf(), { controllerRef: 'another-controller' }),
              configuration,
              contribution: Option.some(contribution),
              externalCopies: [copy],
            }),
          ),
        );
        const foreignAnswer = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), foreign.capabilities);
        expect(entryOf(foreignAnswer)).not.toHaveProperty('contribution');
        expect(entryOf(foreignAnswer)).not.toHaveProperty('externalCopies');
        expect(entryOf(foreignAnswer)).not.toHaveProperty('configuration');
        // no owner other than Communications ever carries one of the three
        for (const entry of answer.result.entries.filter(({ moduleId }) => moduleId !== OWNER)) {
          expect(new Set(Object.keys(entry))).toEqual(
            new Set(['moduleId', 'observedAt', 'reason', 'requiredByCoverageRefs', 'resourceRefs', 'status']),
          );
        }
      }),
  );

  it.effect('keeps a foreign tenant not found and asks nobody', () =>
    Effect.gen(function* foreign() {
      const { asked, capabilities } = capabilitiesOf(communicationsActivity, foreignTenant, (request) =>
        Effect.succeed(ok(answerFor(request))),
      );
      const exit = yield* Effect.exit(runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '').toContain('ReadHandlerNotFound');
      expect(asked).toEqual([]);
    }),
  );
});
