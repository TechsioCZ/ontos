import type {
  PrivacyOwnerCoverageRequest,
  PrivacyOwnerCoverageResponse,
} from '@app/communications/api/privacy-owner-coverage';
import { assessCommunicationsOwnerCoverage } from '@app/communications/privacy-owner/coverage';
import { INVENTORY_CATEGORY_IDS, scopePartRefs } from '@app/communications/privacy-owner/inventory';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { Cause, Effect, Exit, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { lookupPrivacyOwnerInventory } from '../../shared/domain/owner-inventory.ts';
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

describe('Privacy owner inventory with Communications coverage', () => {
  it.effect('answers other owners exactly as before and asks nobody when no subject lookup is named', () =>
    Effect.gen(function* unchangedForOtherOwners() {
      const other = activityWith(tenantId, [
        coverageEntry(tenantId, 'party.registry', 'party-record'),
        coverageEntry(tenantId, 'commerce.customer-context', 'profile'),
      ]);
      const { asked, capabilities } = capabilitiesOf(other, tenantId, () =>
        Effect.succeed({ _tag: 'Unavailable', reason: 'must not be asked', retryable: true }),
      );
      const before = lookupPrivacyOwnerInventory({
        activity: other,
        composition: { modules: [{ moduleId: 'commerce.customer-context' }, { moduleId: 'party.registry' }] },
      });
      const answer = yield* runOwnerInventory(plainRequestOf(tenantId), capabilities);
      expect(answer.result).toEqual(before);
      // a lookup for an activity that declares no Communications scope asks nobody either
      const withLookup = yield* runOwnerInventory(lookupRequestOf(tenantId, 'customer-1'), capabilities);
      expect(withLookup.result).toEqual(before);
      expect(asked).toEqual([]);
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
        expect(reasonOf(partialAnswer)).toBe('BACKUP_AND_RECOVERY_COPIES_NOT_OBSERVABLE_BY_OWNER');
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
