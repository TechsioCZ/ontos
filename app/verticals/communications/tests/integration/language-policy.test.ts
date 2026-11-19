import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { tenantLanguageModeVersions } from '../../src/database/schema.ts';
import {
  effectiveLanguagePolicy,
  readLanguagePolicySnapshot,
  setLanguageMode,
} from '../../src/services/language-policy-domain.service.ts';
import { postgresLanguagePolicyPort } from '../../src/services/language-policy.service.ts';
import { decideMessageLanguage, verifyLanguageForHandoff } from '../../src/services/language-selection.service.ts';
import type { DecideLanguageInput } from '../../src/services/language-selection.service.ts';
import { baseIdentity, seedLanguages, selectedOf } from '../support/language-fixtures.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';

const trustedEnglish: DecideLanguageInput = {
  base: baseIdentity,
  ownerPermittedLanguages: ['cs', 'en'],
  recipient: { kind: 'trusted', language: 'en' },
};
const policyActor = (actionInvocationId: string) => {
  const { principalId } = actorWith(actionInvocationId);
  return { actionInvocationId, principalId };
};
type RuntimeDatabase = Effect.Success<ReturnType<typeof makeRuntimeDatabase>>;
const changeMode = (database: RuntimeDatabase, tenant: string, mode: 'A' | 'B') =>
  database.withPorts(tenant, (_templates, policies) =>
    Effect.gen(function* setOne() {
      return yield* setLanguageMode(policies, mode, policyActor(yield* nextId));
    }),
  );

describe('The Tenant language mode on native PostgreSQL as the runtime role (L-13, AC-11)', () => {
  it.live('is B for a Tenant without an own choice, then B to A to B with a growing, safe version history', () =>
    Effect.gen(function* modeLifecycle() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const defaultMode = yield* database.withPorts(tenant, (_templates, policies) =>
        effectiveLanguagePolicy(policies),
      );
      expect(defaultMode).toEqual({ mode: 'B', policy: { platformDefaultVersion: 1, source: 'platform-default' } });
      const set = (mode: 'A' | 'B') => changeMode(database, tenant, mode);
      const toA = yield* set('A');
      const again = yield* set('A');
      const toB = yield* set('B');
      expect([toA.changed, again.changed, toB.changed]).toEqual([true, false, true]);
      expect([toA.effective.mode, toB.effective.mode]).toEqual(['A', 'B']);
      expect(toA.effective.policy).toMatchObject({ source: 'tenant', versionNumber: 1 });
      expect(toB.effective.policy).toMatchObject({ source: 'tenant', versionNumber: 2 });
      const current = yield* database.withPorts(tenant, (_templates, policies) => effectiveLanguagePolicy(policies));
      expect(current).toEqual(toB.effective);
      // the history keeps both versions: nothing earlier is rewritten by a later choice
      const history = yield* database.inTenant(tenant, (transaction) =>
        transaction.select().from(tenantLanguageModeVersions),
      );
      expect(
        history
          .toSorted((left, right) => left.versionNumber - right.versionNumber)
          .map((row) => [row.versionNumber, row.mode]),
      ).toEqual([
        [1, 'A'],
        [2, 'B'],
      ]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('keeps each Tenant on its own mode: another Tenant sees neither the choice nor the history', () =>
    Effect.gen(function* tenantIsolation() {
      const database = yield* makeRuntimeDatabase();
      const tenantOne = yield* nextId;
      const tenantTwo = yield* nextId;
      yield* changeMode(database, tenantOne, 'A');
      expect((yield* database.withPorts(tenantOne, (_t, policies) => effectiveLanguagePolicy(policies))).mode).toBe(
        'A',
      );
      expect(yield* database.withPorts(tenantTwo, (_t, policies) => effectiveLanguagePolicy(policies))).toEqual({
        mode: 'B',
        policy: { platformDefaultVersion: 1, source: 'platform-default' },
      });
      const foreignRows = yield* database.inTenant(tenantTwo, (transaction) =>
        transaction.select().from(tenantLanguageModeVersions),
      );
      expect(foreignRows).toEqual([]);
      // an own write numbers from one again: the number is per Tenant
      const second = yield* database.withPorts(tenantTwo, (_t, policies) =>
        Effect.gen(function* setTwo() {
          return yield* setLanguageMode(policies, 'A', policyActor(yield* nextId));
        }),
      );
      expect(second.effective.policy).toMatchObject({ source: 'tenant', versionNumber: 1 });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('refuses to rewrite or remove a version and to write a version of another Tenant', () =>
    Effect.gen(function* appendOnly() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const otherTenant = yield* nextId;
      yield* database.withPorts(tenant, (_t, policies) =>
        Effect.gen(function* seed() {
          return yield* setLanguageMode(policies, 'A', policyActor(yield* nextId));
        }),
      );
      const attempt = <Value, Failure, Requirements>(
        inTenant: string,
        program: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
      ) => Effect.exit(database.inTenant(inTenant, program));
      const outcomes = [
        yield* attempt(tenant, (transaction) => transaction.update(tenantLanguageModeVersions).set({ mode: 'B' })),
        yield* attempt(tenant, (transaction) => transaction.delete(tenantLanguageModeVersions)),
        // a transaction of another Tenant cannot append a version of this Tenant
        yield* attempt(otherTenant, (transaction) =>
          transaction.insert(tenantLanguageModeVersions).values({
            actionInvocationId: tenant,
            mode: 'A',
            policyVersionId: otherTenant,
            setByPrincipalId: tenant,
            tenantId: tenant,
            versionNumber: 2,
          }),
        ),
        // the mode is A or B in the database too, not only in the payload
        yield* attempt(otherTenant, (transaction) =>
          transaction.insert(tenantLanguageModeVersions).values({
            actionInvocationId: tenant,
            mode: JSON.parse('"C"'),
            policyVersionId: tenant,
            setByPrincipalId: tenant,
            tenantId: otherTenant,
            versionNumber: 1,
          }),
        ),
      ];
      expect(outcomes.map((outcome) => Exit.isFailure(outcome))).toEqual([true, true, true, true]);
      const stored = yield* database.withPorts(tenant, (_t, policies) => effectiveLanguagePolicy(policies));
      expect(stored.mode).toBe('A');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('serializes concurrent changes of one Tenant: no number is used twice', () =>
    Effect.gen(function* concurrent() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const change = (mode: 'A' | 'B') => changeMode(database, tenant, mode);
      yield* Effect.all([change('A'), change('B'), change('A'), change('B')], { concurrency: 4 });
      const history = yield* database.inTenant(tenant, (transaction) =>
        transaction.select().from(tenantLanguageModeVersions),
      );
      const numbers = history.map((row) => row.versionNumber).toSorted((left, right) => left - right);
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
      // no version repeats the mode before it: an unchanged choice is never appended
      const modes = history.toSorted((left, right) => left.versionNumber - right.versionNumber).map((row) => row.mode);
      expect(modes.every((mode, index) => index === 0 || mode !== modes[index - 1])).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('is unreadable, not the default, when the store cannot answer: a decision stops and nothing is guessed', () =>
    Effect.gen(function* unreadable() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      yield* database.withPorts(tenant, (templates) => seedLanguages(templates, ['cs', 'en']));
      // a Tenant value the store cannot use is a failing read: the setting is unreadable, not absent. The failed
      // statement aborts its transaction, so the program ends by rolling back with the snapshot it observed.
      const observed = yield* Effect.flip(
        database.inTenant(tenant, (transaction) =>
          readLanguagePolicySnapshot(postgresLanguagePolicyPort(transaction, { tenantId: 'not-a-tenant' })).pipe(
            Effect.flatMap((snapshot) => Effect.fail(snapshot)),
          ),
        ),
      );
      expect(observed).toEqual({ kind: 'unreadable' });
      const failed = yield* Effect.exit(
        database.inTenant(tenant, (transaction) =>
          effectiveLanguagePolicy(postgresLanguagePolicyPort(transaction, { tenantId: 'not-a-tenant' })),
        ),
      );
      expect(Exit.isFailure(failed)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

describe('Decisions on native PostgreSQL pin the Tenant mode and survive its changes (S07, S08, AC-03, AC-11)', () => {
  it.live(
    'B stops an English-only type, A allows it, B again stops its handoff, and nothing earlier is rewritten',
    () =>
      Effect.gen(function* decisions() {
        const database = yield* makeRuntimeDatabase();
        const tenantOne = yield* nextId;
        const tenantTwo = yield* nextId;
        for (const tenant of [tenantOne, tenantTwo]) {
          yield* database.withPorts(tenant, (templates) => seedLanguages(templates, ['en']));
        }
        const decide = (tenant: string) =>
          database.withPorts(tenant, (templates, policies) =>
            decideMessageLanguage(templates, policies, trustedEnglish),
          );
        const set = (tenant: string, mode: 'A' | 'B') => changeMode(database, tenant, mode);

        const earlier = yield* decide(tenantOne);
        expect(earlier).toMatchObject({ mode: 'B', outcome: 'not-sent', reason: 'czech_revision_required_by_mode_b' });
        yield* set(tenantOne, 'A');
        const underA = yield* decide(tenantOne);
        expect(underA).toMatchObject({ language: 'en', mode: 'A', outcome: 'selected', policy: { versionNumber: 1 } });
        // the other Tenant is still on B, with the same template shape in its own scope
        expect(yield* decide(tenantTwo)).toMatchObject({ mode: 'B', outcome: 'not-sent' });
        const pinned = selectedOf(underA);
        yield* set(tenantOne, 'B');
        const gate = yield* database.withPorts(tenantOne, (templates, policies) =>
          verifyLanguageForHandoff(templates, policies, pinned),
        );
        expect(gate).toEqual({ currentMode: 'B', outcome: 'stop', reason: 'czech_revision_required_by_mode_b' });
        // the stored decision is a value the gate never rewrote: language, revision, mode and policy version intact
        expect(underA).toMatchObject({ language: 'en', mode: 'A', pin: { revisionNumber: 1 } });
        // the earlier not-sent decision stays not-sent; only a new request is decided again
        expect(earlier.outcome).toBe('not-sent');
        expect(yield* decide(tenantOne)).toMatchObject({ mode: 'B', outcome: 'not-sent' });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('a Czech revision of another Tenant is never used, whichever mode the Tenant is on', () =>
    Effect.gen(function* foreignTemplate() {
      const database = yield* makeRuntimeDatabase();
      const tenantOne = yield* nextId;
      const tenantTwo = yield* nextId;
      yield* database.withPorts(tenantOne, (templates) => seedLanguages(templates, ['en']));
      yield* database.withPorts(tenantTwo, (templates) => seedLanguages(templates, ['cs', 'en']));
      for (const mode of ['B', 'A'] as const) {
        yield* changeMode(database, tenantOne, mode);
        const decision = yield* database.withPorts(tenantOne, (templates, policies) =>
          decideMessageLanguage(templates, policies, { ...trustedEnglish, recipient: { kind: 'not-established' } }),
        );
        expect(decision).toMatchObject({ outcome: 'not-sent', reason: 'czech_revision_unavailable' });
      }
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
