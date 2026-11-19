import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Cause, Deferred, Effect, Exit, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TemplateStoreUnavailable } from '../../shared/template-revision-errors.ts';
import {
  templateActivations,
  templateRevisionInvalidations,
  templateRevisions,
  templateTypes,
} from '../../src/database/schema.ts';
import {
  actorFor,
  companyA,
  companyB,
  companyScope,
  domainFor,
  fictionalDraft,
  identity,
} from '../support/template-fixtures.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';

describe('Template revisions on native PostgreSQL as the runtime role', () => {
  it.live('prepares, activates, replaces, pins and audits through the real port with Tenant isolation', () =>
    Effect.gen(function* lifecycle() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const otherTenant = yield* nextId;
      const { first, pin, second } = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* firstTransaction() {
          const t = domainFor(port);
          const actor = actorWith(yield* nextId);
          const prepared = yield* t.prepare(fictionalDraft(), actor);
          const next = yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] second {{purpose}}' }), actor);
          yield* t.approve(prepared.revision.revisionId, actor);
          return { first: prepared.revision, pin: yield* t.resolve(identity()), second: next.revision };
        }),
      );
      expect([first.revisionNumber, second.revisionNumber]).toEqual([1, 2]);
      expect(pin.revisionId).toBe(first.revisionId);
      yield* database.withPort(tenant, (port) =>
        Effect.gen(function* replace() {
          const t = domainFor(port);
          const replaced = yield* t.approve(second.revisionId, actorWith(yield* nextId));
          expect(replaced.replaced?.revisionId).toBe(first.revisionId);
          // the retry of the pinned message keeps revision 1, a new request gets revision 2
          expect((yield* t.verify(pin)).revisionId).toBe(first.revisionId);
          expect((yield* t.resolve(identity())).revisionId).toBe(second.revisionId);
          const audit = yield* t.describe(pin);
          expect(audit.activeAtDecisionTime).toBe(true);
          expect(audit.activations[0]?.endedKind).toBe('replaced');
        }),
      );
      yield* database.withPort(otherTenant, (port) =>
        Effect.gen(function* foreignTenant() {
          expect(Option.isNone(yield* port.loadRevision(first.revisionId))).toBe(true);
          expect(Option.isNone(yield* port.findType(identity()))).toBe(true);
          // the same Type identity is a different Type in another Tenant
          const foreign = yield* domainFor(port).prepare(fictionalDraft(), actorWith(yield* nextId));
          expect(foreign.type.templateTypeId).not.toBe(first.templateTypeId);
          expect(foreign.revision.revisionNumber).toBe(1);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('serializes concurrent activations and concurrent preparation of one Type', () =>
    Effect.gen(function* concurrent() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const prepareOne = (body: string) =>
        database.withPort(tenant, (port) =>
          Effect.gen(function* run() {
            return (yield* domainFor(port).prepare(fictionalDraft({ body }), actorWith(yield* nextId))).revision;
          }),
        );
      const [one, two] = yield* Effect.all(
        [prepareOne('[FICTIONAL TEST COPY] one {{purpose}}'), prepareOne('[FICTIONAL TEST COPY] two {{purpose}}')],
        { concurrency: 2 },
      );
      expect([one.revisionNumber, two.revisionNumber].toSorted((left, right) => left - right)).toEqual([1, 2]);
      expect(one.templateTypeId).toBe(two.templateTypeId);
      const activate = (revisionId: string) =>
        database.withPort(tenant, (port) =>
          Effect.gen(function* run() {
            return yield* domainFor(port).approve(revisionId, actorWith(yield* nextId));
          }),
        );
      yield* Effect.all([activate(one.revisionId), activate(two.revisionId)], { concurrency: 2 });
      const open = yield* database.withPort(tenant, (port) => port.openActivations(one.templateTypeId));
      expect(open).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('takes business time after the Type lock so racing activations never end a period before it started', () =>
    Effect.gen(function* race() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const [one, two] = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* seed() {
          const t = domainFor(port);
          const actor = actorWith(yield* nextId);
          const first = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] one {{purpose}}' }), actor))
            .revision;
          const second = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] two {{purpose}}' }), actor))
            .revision;
          return [first, second] as const;
        }),
      );
      const slowBegan = yield* Deferred.make<boolean>();
      const fastActivated = yield* Deferred.make<boolean>();
      // The slow transaction begins first, so its transaction time is the earliest, but it takes the Type lock last.
      // A transaction-time clock would stamp its activation before the period it closes even started; business time
      // taken under the lock cannot. The ordering is forced, so the failure of such a clock is deterministic.
      const slow = database.withPort(tenant, (port) =>
        Effect.gen(function* slowActivation() {
          yield* Deferred.succeed(slowBegan, true);
          yield* Deferred.await(fastActivated);
          return yield* domainFor(port).approve(two.revisionId, actorWith(yield* nextId));
        }),
      );
      const fast = database.withPort(tenant, (port) =>
        Effect.gen(function* fastActivation() {
          yield* Deferred.await(slowBegan);
          const activated = yield* domainFor(port).approve(one.revisionId, actorWith(yield* nextId));
          // the slow transaction proceeds while this one still holds the Type lock and its uncommitted activation
          yield* Deferred.succeed(fastActivated, true);
          return activated;
        }),
      );
      yield* Effect.all([slow, fast], { concurrency: 2 });
      const all = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* read() {
          return [
            ...(yield* port.activationsOfRevision(one.revisionId)),
            ...(yield* port.activationsOfRevision(two.revisionId)),
          ];
        }),
      );
      expect(all).toHaveLength(2);
      const open = all.filter((activation) => Option.isNone(activation.ending));
      expect(open).toHaveLength(1);
      const ordered = all.every((activation) =>
        Option.match(activation.ending, {
          onNone: () => true,
          onSome: (ending) => ending.endedAt.epochMilliseconds >= activation.activatedAt.epochMilliseconds,
        }),
      );
      expect(ordered).toBe(true);
      // the activation that replaced the other ends it exactly where its own period starts: one gapless timeline
      const closedAt = all.flatMap((activation) =>
        Option.match(activation.ending, { onNone: () => [], onSome: (ending) => [ending.endedAt.epochMilliseconds] }),
      );
      expect(closedAt).toEqual(open.map((activation) => activation.activatedAt.epochMilliseconds));
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('lets the store itself refuse a second open activation of a Type', () =>
    Effect.gen(function* uniqueness() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const refusal = yield* Effect.flip(
        database.withPort(tenant, (port) =>
          Effect.gen(function* run() {
            const actor = actorWith(yield* nextId);
            const { revision, type } = yield* domainFor(port).prepare(fictionalDraft(), actor);
            const append = port.appendActivation({
              actionInvocationId: actor.actionInvocationId,
              activatedAt: yield* port.clockNow,
              activatedByPrincipalId: actor.principalId,
              activationReason: 'Fictional direct append',
              legalEntityId: null,
              revisionId: revision.revisionId,
              scopeKey: 'tenant',
              templateTypeId: type.templateTypeId,
            });
            yield* append;
            // the refused insert aborts the PostgreSQL transaction, so surface it and let the transaction roll back
            return yield* Effect.flip(append).pipe(Effect.flatMap(Effect.fail));
          }),
        ),
      );
      expect(Schema.is(TemplateStoreUnavailable)(refusal)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('keeps Legal Entity scoped Types apart and never falls back to another company', () =>
    Effect.gen(function* scopes() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      yield* database.withPort(tenant, (port) =>
        Effect.gen(function* run() {
          const t = domainFor(port);
          const scopeB = companyScope(companyB);
          const actorB = actorFor(companyB);
          const { revision } = yield* t.prepare(fictionalDraft({ scope: scopeB }), actorB);
          yield* t.approve(revision.revisionId, actorB);
          expect((yield* t.resolve(identity({ scope: scopeB }))).revisionId).toBe(revision.revisionId);
          expect(yield* Effect.flip(t.resolve(identity({ scope: companyScope(companyA) })))).toMatchObject({
            code: 'template_no_active_revision',
          });
          expect(yield* Effect.flip(t.resolve(identity()))).toMatchObject({ code: 'template_no_active_revision' });
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('keeps an unsafe-invalidated revision gated, closes its activation and rewrites no history', () =>
    Effect.gen(function* invalidation() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      yield* database.withPort(tenant, (port) =>
        Effect.gen(function* run() {
          const t = domainFor(port);
          const actor = actorWith(yield* nextId);
          const { revision } = yield* t.prepare(fictionalDraft(), actor);
          yield* t.approve(revision.revisionId, actor);
          const pin = yield* t.resolve(identity());
          yield* t.invalidate(revision.revisionId, 'Fictional unsafe wording', actor);
          expect(yield* Effect.flip(t.verify(pin))).toMatchObject({
            code: 'pinned_template_revision_invalidated_unsafe',
          });
          expect(yield* Effect.flip(t.resolve(identity()))).toMatchObject({ code: 'template_no_active_revision' });
          const audit = yield* t.describe(pin);
          expect(audit.lifecycleState).toBe('invalidated-unsafe');
          expect(audit.activations[0]?.endedKind).toBe('invalidated-unsafe');
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'refuses to rewrite or remove stored facts and to cross Tenants: the runtime role is least-privilege under RLS',
    () =>
      Effect.gen(function* privileges() {
        const database = yield* makeRuntimeDatabase();
        const tenant = yield* nextId;
        const otherTenant = yield* nextId;
        const revisionId = yield* database.withPort(tenant, (port) =>
          Effect.gen(function* seed() {
            return (yield* domainFor(port).prepare(fictionalDraft(), actorWith(yield* nextId))).revision.revisionId;
          }),
        );
        const rewrite = yield* Effect.result(
          database.inTenant(tenant, (transaction) =>
            transaction.update(templateRevisions).set({ subject: 'rewritten' }),
          ),
        );
        const removal = yield* Effect.result(
          database.inTenant(tenant, (transaction) => transaction.delete(templateRevisions)),
        );
        const typeRewrite = yield* Effect.result(
          database.inTenant(tenant, (transaction) => transaction.update(templateTypes).set({ language: 'en' })),
        );
        expect([rewrite, removal, typeRewrite].map((outcome) => Result.isFailure(outcome))).toEqual([true, true, true]);
        const stored = yield* database.withPort(tenant, (port) => port.loadRevision(revisionId));
        expect(stored.pipe(Option.map((found) => found.subject))).toEqual(
          Option.some('[FICTIONAL TEST COPY] {{purpose}}'),
        );
        // a transaction for another Tenant cannot write a row of this Tenant either
        const crossTenant = yield* Effect.result(
          database.inTenant(otherTenant, (transaction) =>
            transaction.insert(templateTypes).values({
              actionInvocationId: revisionId,
              channel: 'email',
              createdAt: new Date(0),
              createdByPrincipalId: revisionId,
              language: 'cs',
              legalEntityId: null,
              messageType: 'fixture.cross-tenant',
              scopeKey: 'tenant',
              scopeKind: 'tenant',
              templateTypeId: revisionId,
              tenantId: tenant,
            }),
          ),
        );
        expect(Result.isFailure(crossTenant)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
  it.live(
    'refuses to rewrite, reopen or delete a closed activation or an invalidation: closed history is append-only',
    () =>
      Effect.gen(function* closedHistory() {
        const database = yield* makeRuntimeDatabase();
        const tenant = yield* nextId;
        const seeded = yield* database.withPort(tenant, (port) =>
          Effect.gen(function* seed() {
            const t = domainFor(port);
            const actor = actorWith(yield* nextId);
            const first = (yield* t.prepare(fictionalDraft(), actor)).revision;
            const second = (yield* t.prepare(fictionalDraft({ body: '[FICTIONAL TEST COPY] two {{purpose}}' }), actor))
              .revision;
            yield* t.approve(first.revisionId, actor);
            yield* t.approve(second.revisionId, actor);
            yield* t.invalidate(second.revisionId, 'Fictional unsafe wording', actor);
            return { first, second };
          }),
        );
        // both activations are now closed: the first was replaced, the second invalidated as unsafe
        const attempt = <Value, Failure, Requirements>(
          program: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure, Requirements>,
        ) => Effect.exit(database.inTenant(tenant, program));
        const rewrite = yield* attempt((transaction) =>
          transaction.update(templateActivations).set({ endReason: 'rewritten history' }),
        );
        const reopen = yield* attempt((transaction) =>
          transaction
            .update(templateActivations)
            .set({ endedAt: null, endedByPrincipalId: null, endedKind: null, endInvocationId: null, endReason: null }),
        );
        const refused = yield* Effect.all(
          [
            attempt((transaction) => transaction.delete(templateActivations)),
            attempt((transaction) => transaction.update(templateRevisionInvalidations).set({ reason: 'rewritten' })),
            attempt((transaction) => transaction.delete(templateRevisionInvalidations)),
            // the opening columns of an activation are not updatable by the runtime role at all
            attempt((transaction) => transaction.update(templateActivations).set({ activationReason: 'rewritten' })),
          ],
          { concurrency: 1 },
        );
        expect([rewrite, reopen, ...refused].map((outcome) => Exit.isFailure(outcome))).toEqual([
          true,
          true,
          true,
          true,
          true,
          true,
        ]);
        // a closed row is refused by the trigger itself, not merely for want of a privilege
        for (const outcome of [rewrite, reopen]) {
          expect(Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : '').toContain(
            'closed template activations are append-only',
          );
        }
        const stored = yield* database.withPort(tenant, (port) =>
          Effect.gen(function* read() {
            return {
              first: yield* port.activationsOfRevision(seeded.first.revisionId),
              invalidation: yield* port.findInvalidation(seeded.second.revisionId),
              open: yield* port.openActivations(seeded.first.templateTypeId),
              second: yield* port.activationsOfRevision(seeded.second.revisionId),
            };
          }),
        );
        expect(stored.first.map((found) => found.ending.pipe(Option.map((ending) => ending.endedKind)))).toEqual([
          Option.some('replaced'),
        ]);
        expect(stored.second.map((found) => found.ending.pipe(Option.map((ending) => ending.endReason)))).toEqual([
          Option.some('Fictional unsafe wording'),
        ]);
        expect(stored.open).toHaveLength(0);
        expect(Option.isSome(stored.invalidation)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('lets the database itself tie an activation to the Type and scope of its revision', () =>
    Effect.gen(function* activationIdentity() {
      const database = yield* makeRuntimeDatabase();
      const tenant = yield* nextId;
      const seeded = yield* database.withPort(tenant, (port) =>
        Effect.gen(function* seed() {
          const t = domainFor(port);
          const actor = actorFor(companyA);
          const tenantWide = (yield* t.prepare(fictionalDraft(), actorWith(yield* nextId))).revision;
          const company = (yield* t.prepare(fictionalDraft({ scope: companyScope(companyA) }), actor)).revision;
          return { company, tenantWide };
        }),
      );
      const forged = (
        override: Partial<{ legalEntityId: string | null; scopeKey: string; templateTypeId: string }>,
        revisionId: string,
      ) =>
        Effect.exit(
          database.withPort(tenant, (port) =>
            Effect.gen(function* append() {
              const actor = actorWith(yield* nextId);
              return yield* port.appendActivation({
                actionInvocationId: actor.actionInvocationId,
                activatedAt: yield* port.clockNow,
                activatedByPrincipalId: actor.principalId,
                activationReason: 'Fictional forged activation',
                legalEntityId: null,
                revisionId,
                scopeKey: 'tenant',
                templateTypeId: seeded.tenantWide.templateTypeId,
                ...override,
              });
            }),
          ),
        );
      const outcomes = yield* Effect.all(
        [
          // the revision of one Type cannot be activated under another Type of the same Tenant
          forged(
            {
              legalEntityId: companyA,
              scopeKey: `legal-entity:${companyA}`,
              templateTypeId: seeded.company.templateTypeId,
            },
            seeded.tenantWide.revisionId,
          ),
          // nor under a scope other than the one of its Type
          forged({ legalEntityId: companyB, scopeKey: `legal-entity:${companyB}` }, seeded.tenantWide.revisionId),
          forged(
            { legalEntityId: null, scopeKey: 'tenant', templateTypeId: seeded.company.templateTypeId },
            seeded.company.revisionId,
          ),
          // a scope key without its Legal Entity is not a scope
          forged(
            {
              legalEntityId: null,
              scopeKey: `legal-entity:${companyA}`,
              templateTypeId: seeded.company.templateTypeId,
            },
            seeded.company.revisionId,
          ),
        ],
        { concurrency: 1 },
      );
      expect(outcomes.map((outcome) => Exit.isFailure(outcome))).toEqual([true, true, true, true]);
      // the matching activation is accepted
      const accepted = yield* forged({}, seeded.tenantWide.revisionId);
      expect(Exit.isSuccess(accepted)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
