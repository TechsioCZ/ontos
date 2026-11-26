import { NodeCrypto } from '@effect/platform-node';
import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { TemplateIdentity, TemplateScope } from '../../shared/template-revision.ts';
import { decideMessageLanguage, verifyLanguageForHandoff } from '../../src/services/language-selection.service.ts';
import { makeInMemoryTemplatePort } from '../support/in-memory-template-port.ts';
import { makeInMemoryLanguagePolicyPort, selectedOf } from '../support/language-fixtures.ts';
import {
  actorFor,
  adminOne,
  companyA,
  companyB,
  companyScope,
  domainFor,
  fictionalDraft,
} from '../support/template-fixtures.ts';

/**
 * R-D7 (#1397 TPL-02, #1398 T-01/AC-04): a request in a Legal Entity that has no revision of its own for the exact type,
 * channel and language is served by the Tenant-wide approved revision, never silently by a built-in or foreign text, and the
 * pin records the scope that was chosen. A Legal Entity that took the identity over keeps it, also when it stopped it.
 */

const TYPE = 'fixture.scoped-notice';
const tenant: TemplateScope = { kind: 'tenant' };
const identityIn = (scope: TemplateScope, language: 'cs' | 'en' = 'cs'): TemplateIdentity => ({
  channel: 'email',
  language,
  messageType: TYPE,
  scope,
});
const draftIn = (scope: TemplateScope, label: string, language: 'cs' | 'en' = 'cs') =>
  fictionalDraft({
    ...identityIn(scope, language),
    body: `[FICTIONAL TEST COPY] ${label}`,
    optionalPlaceholders: [],
    requiredPlaceholders: [],
    subject: `[FICTIONAL TEST COPY] ${label}`,
  });
const actorOf = (scope: TemplateScope) => actorFor(scope.kind === 'tenant' ? null : scope.legalEntityId);
const activated = (
  port: ReturnType<typeof makeInMemoryTemplatePort>['port'],
  scope: TemplateScope,
  label: string,
  language: 'cs' | 'en' = 'cs',
) =>
  Effect.gen(function* activate() {
    const t = domainFor(port);
    const prepared = yield* t.prepare(draftIn(scope, label, language), actorOf(scope));
    yield* t.approve(prepared.revision.revisionId, actorOf(scope));
    return prepared.revision;
  });

describe('A Legal Entity request without an own revision falls to the Tenant-wide approved revision (R-D7)', () => {
  it.effect('pins the Tenant-wide revision and records the Tenant scope it was taken from', () =>
    Effect.gen(function* fallback() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const tenantWide = yield* activated(memory.port, tenant, 'tenant-wide');
      const pin = yield* t.resolve(identityIn(companyScope(companyA)));
      expect(pin).toMatchObject({
        contentDigest: tenantWide.contentDigest,
        revisionId: tenantWide.revisionId,
        scope: tenant,
        source: 'TENANT_REVISION',
      });
      // and the audit of that pin names the Tenant scope, so the history shows which scope served the message
      expect((yield* t.describe(pin)).identity.scope).toEqual(tenant);
      expect((yield* t.verify(pin)).revisionId).toBe(tenantWide.revisionId);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('prefers the Legal Entity own revision and never serves another Legal Entity text', () =>
    Effect.gen(function* own() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      yield* activated(memory.port, tenant, 'tenant-wide');
      const ownA = yield* activated(memory.port, companyScope(companyA), 'company-a');
      const inA = yield* t.resolve(identityIn(companyScope(companyA)));
      expect(inA).toMatchObject({ revisionId: ownA.revisionId, scope: companyScope(companyA) });
      // company B never took the identity over: it gets the Tenant-wide text, not company A's
      const inB = yield* t.resolve(identityIn(companyScope(companyB)));
      expect(inB).toMatchObject({ scope: tenant });
      expect(inB.revisionId).not.toBe(ownA.revisionId);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('fails with no active revision when neither the Legal Entity nor the Tenant has one', () =>
    Effect.gen(function* none() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      // a draft never takes an identity over
      yield* t.prepare(draftIn(companyScope(companyA), 'draft-only'), actorOf(companyScope(companyA)));
      expect(yield* Effect.flip(t.resolve(identityIn(companyScope(companyA))))).toMatchObject({
        code: 'template_no_active_revision',
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'fails closed for a Legal Entity that took the identity over and stopped it: no fallback re-enables a text',
    () =>
      Effect.gen(function* stopped() {
        const memory = makeInMemoryTemplatePort();
        const t = domainFor(memory.port);
        yield* activated(memory.port, tenant, 'tenant-wide');
        const ownA = yield* activated(memory.port, companyScope(companyA), 'company-a');
        yield* t.deactivate(ownA.revisionId, 'Fictional retirement', actorOf(companyScope(companyA)));
        expect(yield* Effect.flip(t.resolve(identityIn(companyScope(companyA))))).toMatchObject({
          code: 'template_no_active_revision',
        });
        // the Tenant-wide request is untouched by what a Legal Entity did
        expect((yield* t.resolve(identityIn(tenant))).scope).toEqual(tenant);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('never lets a Tenant-wide request use a Legal Entity text', () =>
    Effect.gen(function* oneWay() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      yield* activated(memory.port, companyScope(companyA), 'company-a');
      expect(yield* Effect.flip(t.resolve(identityIn(tenant)))).toMatchObject({ code: 'template_no_active_revision' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'selects the language over the Tenant-wide revision and passes the last handoff gate with the Tenant scope pin',
    () =>
      Effect.gen(function* decided() {
        const memory = makeInMemoryTemplatePort();
        const policies = makeInMemoryLanguagePolicyPort();
        const tenantWide = yield* activated(memory.port, tenant, 'tenant-wide');
        const decision = selectedOf(
          yield* decideMessageLanguage(memory.port, policies.port, {
            base: { channel: 'email', messageType: TYPE, scope: companyScope(companyA) },
            ownerPermittedLanguages: ['cs', 'en'],
            recipient: { kind: 'not-established' },
          }),
        );
        expect(decision).toMatchObject({ language: 'cs', pin: { revisionId: tenantWide.revisionId, scope: tenant } });
        // the stored decision carries the chosen scope, so the retry-time gate reads exactly that scope
        expect(yield* verifyLanguageForHandoff(memory.port, policies.port, decision)).toMatchObject({
          outcome: 'proceed',
        });
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('stops, as without any text, when the Legal Entity request has no Czech revision in either scope', () =>
    Effect.gen(function* noCzech() {
      const memory = makeInMemoryTemplatePort();
      const policies = makeInMemoryLanguagePolicyPort();
      yield* activated(memory.port, tenant, 'tenant-wide-english', 'en');
      expect(
        yield* decideMessageLanguage(memory.port, policies.port, {
          base: { channel: 'email', messageType: TYPE, scope: companyScope(companyB) },
          ownerPermittedLanguages: ['cs', 'en'],
          recipient: { kind: 'not-established' },
        }),
      ).toMatchObject({ outcome: 'not-sent', reason: 'czech_revision_unavailable' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('does not let the operating actor of one scope act on the other (the Action scope rule is unchanged)', () =>
    Effect.gen(function* actorScope() {
      const memory = makeInMemoryTemplatePort();
      const t = domainFor(memory.port);
      const failure = yield* Effect.flip(
        t.prepare(draftIn(tenant, 'tenant-wide'), { ...adminOne, legalEntityId: companyA }),
      );
      expect(failure).toMatchObject({ code: 'template_scope_mismatch' });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
