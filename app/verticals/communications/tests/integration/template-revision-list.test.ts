import { ReadPermissionDenied } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { accessReads, nativeRuntimeClient } from '../support/access-reads.ts';
import { actorWith, makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import { companyA, domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 D.2, T-04, AC-01, AC-02: the Tenant administrator reads which Template Revisions the Tenant has, which one is active
 * and the activation history, through Core's REAL Read lifecycle (scripted access gate, not SpiceDB) over REAL owner SQL on
 * native PostgreSQL as the runtime role. It proves the lifecycle and the exact-scope queries, never an authorization graph.
 */

const READ = 'communications.core.template-revision.read';
const SEED_LIST = 'communications.core.template-revision.list';
const NOTICE = 'fixture.transactional-notice';
const draft = (overrides: Parameters<typeof fictionalDraft>[0] = {}) =>
  fictionalDraft({ messageType: NOTICE, ...overrides });
const isDenied = Schema.is(ReadPermissionDenied);

const setup = Effect.fn('TemplateRevisionListTest.setup')(function* setupWorld() {
  const client = yield* nativeRuntimeClient;
  const database = yield* makeRuntimeDatabase();
  const tenant = yield* nextId;
  const foreign = yield* nextId;
  const author = actorWith(yield* nextId);
  // revision 1 was active and was replaced by revision 2, which is active now; revision 3 is only prepared
  const seeded = yield* database.withPort(tenant, (port) =>
    Effect.gen(function* seedTenant() {
      const t = domainFor(port);
      const first = yield* t.prepare(draft(), author);
      yield* t.approve(first.revision.revisionId, author);
      const second = yield* t.prepare(draft(), author);
      yield* t.approve(second.revision.revisionId, author);
      const third = yield* t.prepare(draft(), author);
      return { first: first.revision, second: second.revision, third: third.revision };
    }),
  );
  return { author, client, database, foreign, seeded, tenant };
});

describe('The template revision list on native PostgreSQL through the Read lifecycle (#1398)', () => {
  it.live('lists the Tenant revisions with the active one, the ended one and the activation trace, and no text', () =>
    Effect.gen(function* listing() {
      const { author, client, seeded, tenant } = yield* setup();
      const reads = yield* accessReads(client, { access: { [READ]: 'allowed' }, tenantId: tenant });
      const page = yield* reads.templateRevisions({});
      expect(page.scope).toEqual({ kind: 'tenant' });
      expect(page.nextCursor).toBeUndefined();
      expect(page.items.map((item) => [item.revisionNumber, item.lifecycleState])).toEqual([
        [3, 'draft'],
        [2, 'active'],
        [1, 'retired'],
      ]);
      const [prepared, active, ended] = page.items;
      expect(prepared?.revisionId).toBe(seeded.third.revisionId);
      expect(active).toMatchObject({
        contentDigest: seeded.second.contentDigest,
        createdByPrincipalId: author.principalId,
        identity: { language: 'cs', messageType: NOTICE, scope: { kind: 'tenant' } },
        requiredPlaceholders: ['purpose'],
        revisionId: seeded.second.revisionId,
      });
      expect(active?.activations).toHaveLength(1);
      expect(active?.activations[0]).toMatchObject({
        activatedByPrincipalId: author.principalId,
        activationReason: 'Fictional approval for tests',
        scopeKey: 'tenant',
      });
      expect(active?.activations[0]?.endedAt).toBeUndefined();
      expect(ended?.revisionId).toBe(seeded.first.revisionId);
      expect(ended?.activations[0]).toMatchObject({ endedByPrincipalId: author.principalId, endedKind: 'replaced' });
      // the wording is not in the answer
      expect(JSON.stringify(page)).not.toContain('FICTIONAL TEST COPY');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('pages by cursor and filters by language without crossing the exact scope', () =>
    Effect.gen(function* paging() {
      const { author, client, database, tenant } = yield* setup();
      yield* database.withPort(tenant, (port) =>
        Effect.gen(function* english() {
          yield* domainFor(port).prepare(draft({ language: 'en' }), author);
          // a Legal Entity Template of the same type is another scope and never joins the Tenant-wide list
          const company = actorWith(yield* nextId, companyA);
          yield* domainFor(port).prepare(draft({ scope: { kind: 'legal-entity', legalEntityId: companyA } }), company);
        }),
      );
      const reads = yield* accessReads(client, { access: { [READ]: 'allowed' }, tenantId: tenant });
      const first = yield* reads.templateRevisions({ limit: 2 });
      expect(first.items.map((item) => [item.identity.language, item.revisionNumber])).toEqual([
        ['cs', 3],
        ['cs', 2],
      ]);
      const cursor = Option.getOrThrow(Option.fromNullishOr(first.nextCursor));
      const second = yield* reads.templateRevisions({ cursor, limit: 2 });
      expect(second.items.map((item) => [item.identity.language, item.revisionNumber])).toEqual([
        ['cs', 1],
        ['en', 1],
      ]);
      expect(second.nextCursor).toBeUndefined();
      expect((yield* reads.templateRevisions({ language: 'en' })).items).toHaveLength(1);
      const company = yield* accessReads(client, {
        access: { [READ]: 'allowed' },
        legalEntityId: companyA,
        tenantId: tenant,
      });
      const own = yield* company.templateRevisions({});
      expect(own.scope).toEqual({ kind: 'legal-entity', legalEntityId: companyA });
      expect(own.items.map((item) => item.identity.scope)).toEqual([{ kind: 'legal-entity', legalEntityId: companyA }]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('shows a foreign Tenant nothing of this Tenant', () =>
    Effect.gen(function* foreignTenant() {
      const { client, foreign } = yield* setup();
      const reads = yield* accessReads(client, { access: { [READ]: 'allowed' }, tenantId: foreign });
      expect(yield* reads.templateRevisions({})).toEqual({ items: [], scope: { kind: 'tenant' } });
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('refuses a caller without the permission, even one that holds only the seed-content review permission', () =>
    Effect.gen(function* denied() {
      const { client, tenant } = yield* setup();
      const reads = yield* accessReads(client, {
        access: { [READ]: 'denied', [SEED_LIST]: 'allowed' },
        tenantId: tenant,
      });
      const failure = yield* Effect.flip(reads.templateRevisions({}));
      expect(isDenied(failure)).toBe(true);
      expect(reads.ownerStatements()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
