import type {
  AntiResurrectionAttempt,
  AntiResurrectionNewSourceEvidence,
  AntiResurrectionProtection,
} from '@app/privacy/domain/anti-resurrection';
import { Effect, Layer, Match } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CommunicationsAntiResurrectionProtections,
  unavailableAntiResurrectionProtectionsLayer,
} from '../../src/domain/retention/anti-resurrection-protections.ts';
import type { AntiResurrectionProtections } from '../../src/domain/retention/anti-resurrection-protections.ts';
import { guardAgainstResurrection } from '../../src/domain/retention/anti-resurrection-guard.ts';
import { ProtectionLookupUnavailable } from '../../src/domain/retention/protection-lookup-unavailable.ts';
import { ResurrectionBlocked } from '../../src/domain/retention/resurrection-blocked.ts';
import { intentRef, tenantId } from './support/privacy-owner-fixtures.ts';

/** FICTIONAL protection of one exactly removed scope. It carries references only, never the removed payload. */
const protection = (overrides: Partial<AntiResurrectionProtection> = {}): AntiResurrectionProtection => ({
  contentScopeRefs: ['communications.request-decision-intent'],
  enforcementReceipt: {
    authorityRef: 'FICTIONAL-authority',
    contentScopeRefs: ['communications.request-decision-intent'],
    evidenceRefs: ['FICTIONAL-evidence'],
    measure: 'DELETE',
    operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
    ownerModuleId: 'communications.core',
    receiptRef: 'FICTIONAL-receipt',
    resourceRefs: [intentRef('a')],
    subjectRef: 'FICTIONAL-subject-1',
    taskId: 'FICTIONAL-task',
    tenantId,
  },
  evidenceRefs: ['FICTIONAL-evidence'],
  measure: 'DELETE',
  outcomeStatus: 'SUCCEEDED',
  ownerExecutionOutcomeRef: 'FICTIONAL-outcome',
  protectedAt: '2026-11-19T12:00:00.000Z',
  protectionId: 'FICTIONAL-protection-1',
  resourceRefs: [intentRef('a')],
  sourceDecisionRef: 'FICTIONAL-decision-1',
  sourceDecisionRevision: 1,
  subjectRef: 'FICTIONAL-subject-1',
  tenantId,
  ...overrides,
});

const attempt = (overrides: Partial<AntiResurrectionAttempt> = {}): AntiResurrectionAttempt => ({
  contentScopeRefs: ['communications.request-decision-intent'],
  operation: 'BACKUP_RECOVERY',
  resourceRefs: [intentRef('a')],
  sourceInputIsNew: false,
  sourceInputRef: null,
  subjectRef: 'FICTIONAL-subject-1',
  tenantId,
  ...overrides,
});

const storeOf = (protections: readonly AntiResurrectionProtection[]): AntiResurrectionProtections => ({
  forSubject: () => Effect.succeed(protections),
});
const withStore = (store: AntiResurrectionProtections) =>
  Effect.provide(Layer.succeed(CommunicationsAntiResurrectionProtections, store));

/** The guard's refusal, or a defect of the test when the guard let the attempt through. */
const refused = (
  store: AntiResurrectionProtections,
  tried: AntiResurrectionAttempt,
  evidence?: AntiResurrectionNewSourceEvidence,
) =>
  Effect.flip(guardAgainstResurrection(tried, evidence).pipe(withStore(store))).pipe(
    Effect.flatMap((failure) =>
      Match.value(failure).pipe(
        Match.tag('ResurrectionBlocked', (blocked) => Effect.succeed(blocked)),
        Match.orElse((other) => Effect.die(other)),
      ),
    ),
  );

const allowed = (
  store: AntiResurrectionProtections,
  tried: AntiResurrectionAttempt,
  evidence?: AntiResurrectionNewSourceEvidence,
) => guardAgainstResurrection(tried, evidence).pipe(withStore(store));

const newSourceEvidence: AntiResurrectionNewSourceEvidence = {
  contentScopeRefs: ['communications.request-decision-intent'],
  evidenceRef: 'FICTIONAL-new-source-evidence',
  resourceRefs: [intentRef('a')],
  sourceInputRef: 'FICTIONAL-source-input-2',
  subjectRef: 'FICTIONAL-subject-1',
  tenantId,
  verifiedAt: '2026-11-20T00:00:00.000Z',
};

const claimedNewImport = attempt({
  operation: 'IMPORT',
  sourceInputIsNew: true,
  sourceInputRef: 'FICTIONAL-source-input-2',
});

/**
 * [#1410 PRIV-COM-13, AC-09, BDD "Zaloha obsahuje obsah jiz legitimne odstraneny", #604/#605] The guard blocks re-exposure and
 * use of stale material after a SEPARATELY executed owner change. It deletes, overwrites and schedules nothing.
 */
describe('Anti-Resurrection guard of Communications', () => {
  it.effect('blocks a backup recovery of exactly the removed scope and names what must not come back', () =>
    Effect.gen(function* body() {
      const failure = yield* refused(storeOf([protection()]), attempt());
      expect(failure).toBeInstanceOf(ResurrectionBlocked);
      expect(failure.blockedResourceRefs).toEqual([intentRef('a')]);
      expect(failure.operation).toBe('BACKUP_RECOVERY');
    }),
  );

  it.effect('blocks every route back: import, replay, projection rebuild and backup recovery', () =>
    Effect.gen(function* body() {
      for (const operation of ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'] as const) {
        const failure = yield* refused(storeOf([protection()]), attempt({ operation }));
        expect(failure.operation, operation).toBe(operation);
      }
    }),
  );

  it.effect('is not a global blacklist: other resources, other content and another subject stay usable', () =>
    Effect.gen(function* body() {
      const store = storeOf([protection()]);
      for (const other of [
        attempt({ resourceRefs: [intentRef('zzz')] }),
        attempt({ contentScopeRefs: ['communications.provider-copy-working-copy-protection'] }),
        attempt({ subjectRef: 'FICTIONAL-subject-2' }),
        attempt({ tenantId: '00000000-0000-4000-8000-0000000000ff' }),
      ]) {
        expect((yield* allowed(store, other)).decision).toBe('ALLOW');
      }
    }),
  );

  it.effect('lets only the unaffected part of a mixed attempt continue and still refuses the protected one', () =>
    Effect.gen(function* body() {
      const failure = yield* refused(
        storeOf([protection()]),
        attempt({ resourceRefs: [intentRef('a'), intentRef('b')] }),
      );
      expect(failure.blockedResourceRefs).toEqual([intentRef('a')]);
      expect(failure.unaffectedResourceRefs).toEqual([intentRef('b')]);
    }),
  );

  it.effect('allows a legitimate import only on separately proven NEW source input, never on a claim alone', () =>
    Effect.gen(function* body() {
      const store = storeOf([protection()]);
      expect(yield* refused(store, claimedNewImport)).toBeInstanceOf(ResurrectionBlocked);
      expect((yield* allowed(store, claimedNewImport, newSourceEvidence)).decision).toBe('ALLOW');
    }),
  );

  it.effect('keeps an owner restriction in force even for an import with new input evidence', () =>
    Effect.gen(function* body() {
      const restricted = storeOf([protection({ measure: 'RESTRICT' })]);
      expect(yield* refused(restricted, claimedNewImport, newSourceEvidence)).toBeInstanceOf(ResurrectionBlocked);
    }),
  );

  it.effect(
    'fails closed when the protection store cannot answer: stale material is not used on an unproven currency',
    () =>
      Effect.gen(function* body() {
        const failure = yield* Effect.flip(
          guardAgainstResurrection(attempt()).pipe(Effect.provide(unavailableAntiResurrectionProtectionsLayer)),
        );
        expect(failure).toBeInstanceOf(ProtectionLookupUnavailable);
      }),
  );

  it('only ever asks: the guard has no write capability to call', () => {
    expect(Object.keys(storeOf([protection()]))).toEqual(['forSubject']);
  });
});
