import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TemplateStoreUnavailable } from '../../shared/template-revision-errors.ts';
import { templateRevisions, templateTypes } from '../../src/database/schema.ts';
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
              activatedAt: yield* port.operationAt,
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
              optionalPlaceholders: [],
              requiredPlaceholders: [],
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
});
