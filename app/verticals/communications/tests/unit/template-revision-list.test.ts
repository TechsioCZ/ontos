import { ReadPermissionDenied } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE,
  TemplateRevisionListItemSchema,
  TemplateRevisionListRequestFieldsSchema,
  TemplateRevisionListResultSchema,
} from '../../shared/template-revision-read.ts';
import type { TemplateRevisionListRequest } from '../../shared/template-revision-read.ts';
import type { TemplateScope } from '../../shared/template-revision.ts';
import { builtInTemplateDefaultsRead } from '../../src/api/built-in-template-defaults.read.ts';
import { templateRevisionListRead } from '../../src/api/template-revision-list.read.ts';
import { listTemplateRevisions } from '../../src/services/template-revision-list-domain.service.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { adminOne, adminTwo, companyA, companyScope, domainFor, fictionalDraft } from '../support/template-fixtures.ts';

/**
 * #1398 D.2, T-04, AC-01, AC-02, T-07: an authorised person reads which Template Revisions a Tenant has, which revision is
 * active per Template Type, language and scope, and the activation history (who, when, scope, reason, ended or
 * invalidated) without the text and without any per-message detail.
 */

const tenantScope: TemplateScope = { kind: 'tenant' };
const NOTICE = 'fixture.transactional-notice';
const OTHER = 'fixture.other-notice';
const draftOf = (language: 'cs' | 'en', messageType = NOTICE, scope: TemplateScope = tenantScope) =>
  fictionalDraft({ language, messageType, scope });
const listIn = (
  port: Parameters<typeof listTemplateRevisions>[0],
  scope: TemplateScope = tenantScope,
  input: TemplateRevisionListRequest = {},
) => listTemplateRevisions(port, scope, input);

describe('The template revision list answers the Tenant administrator (#1398 D.2, T-04, AC-01, AC-02)', () => {
  it.effect('shows a Type with an ended and an active revision, the activation trace and no text', () =>
    Effect.gen(function* twoRevisions() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const first = yield* t.prepare(draftOf('cs'), adminOne);
      yield* t.approve(first.revision.revisionId, adminOne);
      memory.advance(5);
      const second = yield* t.prepare(draftOf('cs'), adminTwo);
      yield* t.approve(second.revision.revisionId, adminTwo);
      memory.advance(5);
      const third = yield* t.prepare(draftOf('cs'), adminOne);

      const page = yield* listIn(memory.port);
      // newest revision first within one Type; the page names the exact scope it answers
      expect(page.items.map((item) => [item.revisionNumber, item.lifecycleState])).toEqual([
        [3, 'draft'],
        [2, 'active'],
        [1, 'retired'],
      ]);
      expect(page.nextCursor).toBeUndefined();
      const [prepared, active, ended] = page.items;
      expect(prepared).toMatchObject({
        activations: [],
        createdByPrincipalId: adminOne.principalId,
        revisionId: third.revision.revisionId,
      });
      expect(active).toMatchObject({
        contentDigest: second.revision.contentDigest,
        createdByPrincipalId: adminTwo.principalId,
        identity: { channel: 'email', language: 'cs', messageType: NOTICE, scope: tenantScope },
        optionalPlaceholders: ['reference'],
        requiredPlaceholders: ['purpose'],
      });
      expect(active?.activations).toHaveLength(1);
      expect(active?.activations[0]).toMatchObject({
        activatedByPrincipalId: adminTwo.principalId,
        activationReason: 'Fictional approval for tests',
        scopeKey: 'tenant',
      });
      expect(active?.activations[0]?.endedAt).toBeUndefined();
      // the replaced revision keeps its whole trace: who activated it, who ended it, why and how
      expect(ended?.activations[0]).toMatchObject({
        activatedByPrincipalId: adminOne.principalId,
        endedByPrincipalId: adminTwo.principalId,
        endedKind: 'replaced',
        scopeKey: 'tenant',
      });
      expect(ended?.activations[0]?.endedAt).toBeDefined();
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('shows a deactivated and an invalidated-unsafe revision as ended and invalidated', () =>
    Effect.gen(function* endings() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const stopped = yield* t.prepare(draftOf('cs'));
      yield* t.approve(stopped.revision.revisionId);
      memory.advance(1);
      yield* t.deactivate(stopped.revision.revisionId, 'Fictional retirement');
      const unsafe = yield* t.prepare(draftOf('en'));
      yield* t.approve(unsafe.revision.revisionId);
      memory.advance(1);
      yield* t.invalidate(unsafe.revision.revisionId, 'Fictional unsafe wording', adminTwo);

      const page = yield* listIn(memory.port);
      expect(page.items.map((item) => [item.identity.language, item.lifecycleState])).toEqual([
        ['cs', 'retired'],
        ['en', 'invalidated-unsafe'],
      ]);
      expect(page.items[0]?.activations[0]).toMatchObject({
        endedKind: 'deactivated',
        endReason: 'Fictional retirement',
      });
      expect(page.items[1]?.invalidation).toMatchObject({
        invalidatedByPrincipalId: adminTwo.principalId,
        reason: 'Fictional unsafe wording',
      });
      expect(page.items[1]?.activations[0]).toMatchObject({ endedKind: 'invalidated-unsafe' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('filters by message type and language and keeps the scope exact', () =>
    Effect.gen(function* filters() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const company = { ...adminOne, legalEntityId: companyA };
      yield* t.prepare(draftOf('cs'));
      yield* t.prepare(draftOf('en'));
      yield* t.prepare(draftOf('cs', OTHER));
      yield* t.prepare(draftOf('cs', NOTICE, companyScope(companyA)), company);

      expect(
        (yield* listIn(memory.port)).items.map(({ identity }) => [identity.messageType, identity.language]),
      ).toEqual([
        [OTHER, 'cs'],
        [NOTICE, 'cs'],
        [NOTICE, 'en'],
      ]);
      expect((yield* listIn(memory.port, tenantScope, { messageType: NOTICE })).items).toHaveLength(2);
      expect((yield* listIn(memory.port, tenantScope, { language: 'en' })).items).toHaveLength(1);
      // a Legal Entity sees only its own Templates; the Tenant-wide ones are not mixed in
      const legalEntity = yield* listIn(memory.port, companyScope(companyA));
      expect(legalEntity.items).toHaveLength(1);
      expect(legalEntity.items[0]?.identity.scope).toEqual(companyScope(companyA));
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('pages by a stable cursor and names a next page exactly when more revisions exist', () =>
    Effect.gen(function* paging() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      yield* t.prepare(draftOf('cs', OTHER));
      yield* t.prepare(draftOf('cs'));
      yield* t.prepare(draftOf('cs'));
      yield* t.prepare(draftOf('en'));

      const first = yield* listIn(memory.port, tenantScope, { limit: 2 });
      expect(
        first.items.map((item) => [item.identity.messageType, item.identity.language, item.revisionNumber]),
      ).toEqual([
        [OTHER, 'cs', 1],
        [NOTICE, 'cs', 2],
      ]);
      const cursor = Option.getOrThrow(Option.fromNullishOr(first.nextCursor));
      const second = yield* listIn(memory.port, tenantScope, { cursor, limit: 2 });
      expect(
        second.items.map((item) => [item.identity.messageType, item.identity.language, item.revisionNumber]),
      ).toEqual([
        [NOTICE, 'cs', 1],
        [NOTICE, 'en', 1],
      ]);
      expect(second.nextCursor).toBeUndefined();
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('carries no template text, no subject and no recipient field in its shape or its answer', () =>
    Effect.gen(function* noText() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const prepared = yield* t.prepare(draftOf('cs'));
      yield* t.approve(prepared.revision.revisionId);
      const page = yield* listIn(memory.port);
      const encoded = JSON.stringify(
        Schema.encodeSync(TemplateRevisionListResultSchema)({ items: page.items, scope: tenantScope }),
      );
      expect(Object.keys(TemplateRevisionListItemSchema.fields)).not.toEqual(
        expect.arrayContaining(['body', 'subject']),
      );
      expect(encoded).not.toContain('FICTIONAL TEST COPY');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it('refuses a page larger than the one technical cap instead of clamping it', () => {
    const decode = Schema.decodeUnknownSync(TemplateRevisionListRequestFieldsSchema);
    expect(decode({ limit: TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE })).toEqual({
      limit: TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE,
    });
    expect(() => decode({ limit: TEMPLATE_REVISION_LIST_MAX_PAGE_SIZE + 1 })).toThrow();
    expect(() => decode({ limit: 0 })).toThrow();
  });
});

const tenantId = '11111111-1111-4111-8111-111111111111';
const principal = {
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:communications-template-revision-list',
  authMethod: 'session' as const,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
};

const readHarness = (access: 'allowed' | 'denied') =>
  makeReadTestHarness({
    access,
    executeOwnerQuery: (query) =>
      Effect.sync(() => {
        // only the principal's own Tenant is ever asked for
        expect(query.sql).toContain('"communications"."template_types"');
        expect(query.params).toContain(tenantId);
        return [];
      }),
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-25T12:00:00Z')),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: communicationsRegistration,
    scope: { ...principal, correlationId: 'template-revision-list-read' },
  });

describe('The template revision list Read through the Core Read runtime (#1398)', () => {
  it('declares its OWN proposed permission, scope-wide, distinct from the seed-content review permission', () => {
    expect(templateRevisionListRead.descriptor.accessDeclaration).toMatchObject({
      key: 'communications.core.template-revision.read',
      kind: 'read',
      modes: ['run'],
      selectors: [],
    });
    expect(templateRevisionListRead.descriptor.accessDeclaration?.key).not.toBe(
      builtInTemplateDefaultsRead.descriptor.accessDeclaration?.key,
    );
    expect(templateRevisionListRead.descriptor.accessWorkload).toBeUndefined();
    expect(templateRevisionListRead.descriptor.legalEntityScope).toBe('optional');
  });

  it.effect('answers an empty Tenant for an allowed caller; a denied caller reads nothing', () =>
    Effect.scoped(
      Effect.gen(function* throughRead() {
        const allowed = yield* readHarness('allowed');
        const result = yield* allowed.runtime.runRead({
          input: {},
          principal,
          registration: templateRevisionListRead,
          transport: { correlationId: 'template-revision-list-read' },
        });
        expect(result).toEqual({ items: [], scope: tenantScope });
        const denied = yield* readHarness('denied');
        const failure = yield* Effect.flip(
          denied.runtime.runRead({
            input: {},
            principal,
            registration: templateRevisionListRead,
            transport: { correlationId: 'template-revision-list-read-denied' },
          }),
        );
        expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
        expect(denied.snapshot().ownerQueries).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
