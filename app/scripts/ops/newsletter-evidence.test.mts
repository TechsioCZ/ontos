import { NoticeVersionsResponseSchema, ProcessingPurposesResponseSchema } from '@app/privacy/api';
import { Effect, Fiber, Layer, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { akrosDemoLegalEntityId, demoTenantId } from '../demo/fixture-ids.mts';
import { DemoSeedError } from '../demo/seed-client.mts';
import type { SeedClient } from '../demo/seed-client.mts';
import {
  NEWSLETTER_STAGE_ORIGIN,
  readNewsletterEvidence,
  withNewsletterEvidenceClient,
} from './newsletter-evidence.mts';

const PURPOSE = '33333333-3333-4333-8333-333333333333';
const PURPOSE_VERSION = '44444444-4444-4444-8444-444444444444';
const NOTICE = '55555555-5555-4555-8555-555555555555';
const VERSION = '66666666-6666-4666-8666-666666666666';
const MARKETING_SCOPE = 'commerce.email-marketing';
const PURPOSE_READ = '/reads/processing-purposes';
const NOTICE_READ = '/reads/notice-versions';
const noNetwork = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die('Unexpected network request in an in-memory test')),
);
const NOW = '2026-11-02T12:00:00.000Z';
const target = {
  legalEntityId: akrosDemoLegalEntityId,
  shellUrl: NEWSLETTER_STAGE_ORIGIN,
  tenantId: demoTenantId,
};
const version = {
  effectiveFrom: NOW,
  effectiveTo: null,
  materialChangeAssessment: null,
  materialScope: {
    applicabilityKey: MARKETING_SCOPE,
    consentRequired: true,
    consentScopeKey: MARKETING_SCOPE,
    controllerRef: akrosDemoLegalEntityId,
    dataCategoryRefs: ['party.contact-email'],
    processingScopeRef: MARKETING_SCOPE,
    recipientRefs: [],
  },
  meaning: 'Voluntary e-mail news',
  recordedAt: NOW,
  requiredConsentDimensions: ['COMMUNICATION_CHANNEL'],
  versionId: PURPOSE_VERSION,
  versionNumber: 1,
};
const purposes = {
  effectiveAt: NOW,
  items: [
    {
      effectiveVersion: version,
      purpose: {
        businessCode: 'EMAIL_MARKETING',
        createdAt: NOW,
        governanceOwnerId: VERSION,
        legalEntityId: akrosDemoLegalEntityId,
        lifecycle: 'ACTIVE',
        purposeRef: {
          moduleId: 'privacy.core',
          resourceId: PURPOSE,
          resourceType: 'privacy.core.processing-purpose',
          tenantId: demoTenantId,
        },
        retiredAt: null,
        versions: [version],
      },
    },
  ],
  missingRefs: [],
  observedAt: NOW,
};
const notice = {
  applicableScope: {
    facts: [
      { dimension: 'CONTROLLER_SCOPE', value: akrosDemoLegalEntityId },
      { dimension: 'PROCESSING_PURPOSE', value: PURPOSE },
      { dimension: 'PROCESSING_PURPOSE_VERSION', value: PURPOSE_VERSION },
      { dimension: 'CHANNEL', value: 'EMAIL' },
    ],
    operation: 'CONSENT_WRITE',
    processingScopeRef: { scopeId: 'commerce.email-marketing.template', scopeType: 'privacy.processing-scope' },
  },
  contentIdentity: 'commerce.email-marketing.sroubshop.cs.v1',
  effectiveFrom: NOW,
  effectiveTo: null,
  evidenceArtifactRef: null,
  language: 'cs',
  noticeRef: {
    moduleId: 'privacy.core',
    resourceId: NOTICE,
    resourceType: 'privacy.core.privacy-notice-version',
    tenantId: demoTenantId,
  },
  recordedAt: NOW,
  versionId: VERSION,
  versionNumber: 1,
  wording: 'Public native Czech notice wording is preserved, not invented by this producer.',
};
const notices = { items: [notice], metadata: { observedAt: NOW } };
const makeClient = (
  purposeResponse: typeof ProcessingPurposesResponseSchema.Encoded,
  noticeResponse: typeof NoticeVersionsResponseSchema.Encoded,
) => {
  const calls: string[] = [];
  const call: SeedClient['call'] = (audience, route, payloadSchema, payload, responseSchema, write) =>
    Effect.gen(function* callPublicRead() {
      expect(audience).toBe('privacy');
      expect(write ?? false).toBe(false);
      calls.push(route);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(payloadSchema))(payload);
      if (route === PURPOSE_READ) {
        expect(encoded).toContain(`"resourceId":"${PURPOSE}"`);
        expect(encoded).toContain(`"tenantId":"${demoTenantId}"`);
        expect(encoded).toContain('"includeRetired":false');
      } else {
        expect(route).toBe(NOTICE_READ);
        expect(encoded).toContain(`"noticeRefs":["${NOTICE}"]`);
        expect(encoded).toContain('"languages":["cs"]');
      }
      return yield* Schema.decodeUnknownEffect(responseSchema)(
        route === PURPOSE_READ ? purposeResponse : noticeResponse,
      );
    });
  const client = {
    call,
    signOut: Effect.sync(() => {
      calls.push('signOut');
    }),
  };
  return { calls, client };
};
const validFixture = Effect.gen(function* publicFixture() {
  return {
    notices: yield* Schema.decodeUnknownEffect(NoticeVersionsResponseSchema)(notices),
    purposes: yield* Schema.decodeUnknownEffect(ProcessingPurposesResponseSchema)(purposes),
  };
});

it.effect('emits only two exact public Privacy responses and ends its own session', () =>
  Effect.gen(function* exactNativeReads() {
    const data = yield* validFixture;
    const { calls, client } = makeClient(data.purposes, data.notices);
    const result = yield* withNewsletterEvidenceClient(Effect.succeed(client), target, PURPOSE, NOTICE);
    expect(calls).toEqual([PURPOSE_READ, NOTICE_READ, 'signOut']);
    expect(result.notices).toContain(VERSION);
    expect(result.notices).toContain(notice.wording);
    expect(result.purposes).toContain(PURPOSE_VERSION);
    expect(result.notices).not.toMatch(/authorization|cookie|password|bearer/iu);
    expect(result.purposes).not.toMatch(/authorization|cookie|password|bearer/iu);
  }).pipe(Effect.provide(noNetwork)),
);
for (const wrong of [
  { ...target, shellUrl: 'http://localhost:3020' },
  { ...target, shellUrl: 'https://ontos-stage-akros.web-revolution.cz' },
  { ...target, tenantId: PURPOSE },
  { ...target, legalEntityId: PURPOSE },
]) {
  it.effect(`refuses non-demo/stage scope ${wrong.shellUrl}/${wrong.tenantId}/${wrong.legalEntityId}`, () =>
    Effect.gen(function* fixedScopeOnly() {
      const data = yield* validFixture;
      const { calls, client } = makeClient(data.purposes, data.notices);
      const result = yield* withNewsletterEvidenceClient(Effect.succeed(client), wrong, PURPOSE, NOTICE).pipe(
        Effect.exit,
      );
      expect(result._tag).toBe('Failure');
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(noNetwork)),
  );
}
it.effect('does not use absent/fake resource IDs or an empty-ref broad query', () =>
  Effect.gen(function* rejectInventedIds() {
    const data = yield* validFixture;
    for (const [purposeId, noticeId] of [
      ['', NOTICE],
      [PURPOSE, 'demo-newsletter.cs.v1'],
    ]) {
      const { calls, client } = makeClient(data.purposes, data.notices);
      const result = yield* readNewsletterEvidence(client, target, purposeId, noticeId).pipe(Effect.exit);
      expect(result._tag).toBe('Failure');
      expect(calls).toEqual([]);
    }
  }).pipe(Effect.provide(noNetwork)),
);
it.effect('rejects stale, missing, duplicate or cross-controller native data and always signs out', () =>
  Effect.gen(function* rejectWrongCatalog() {
    const data = yield* validFixture;
    const [first] = data.purposes.items;
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const wrongPurposes = [
      { ...data.purposes, items: [] },
      { ...data.purposes, items: [first, first] },
      { ...data.purposes, items: [{ ...first, effectiveVersion: null }] },
      { ...data.purposes, items: [{ ...first, purpose: { ...first.purpose, legalEntityId: PURPOSE } }] },
    ];
    for (const response of wrongPurposes) {
      const { calls, client } = makeClient(response, data.notices);
      const result = yield* withNewsletterEvidenceClient(Effect.succeed(client), target, PURPOSE, NOTICE).pipe(
        Effect.exit,
      );
      expect(result._tag).toBe('Failure');
      expect(calls).toEqual([PURPOSE_READ, 'signOut']);
    }
    const wrongNotices = [
      { ...data.notices, items: [] },
      { ...data.notices, items: [notice, notice] },
      { ...data.notices, items: [{ ...notice, noticeRef: { ...notice.noticeRef, tenantId: PURPOSE } }] },
      { ...data.notices, items: [{ ...notice, contentIdentity: 'commerce.email-marketing.cs.v1' }] },
      { ...data.notices, items: [{ ...notice, applicableScope: { ...notice.applicableScope, facts: [] } }] },
    ];
    for (const response of wrongNotices) {
      const native = yield* Schema.decodeUnknownEffect(NoticeVersionsResponseSchema)(response);
      const { calls, client } = makeClient(data.purposes, native);
      const result = yield* withNewsletterEvidenceClient(Effect.succeed(client), target, PURPOSE, NOTICE).pipe(
        Effect.exit,
      );
      expect(result._tag).toBe('Failure');
      expect(calls.at(-1)).toBe('signOut');
    }
  }).pipe(Effect.provide(noNetwork)),
);
it.effect('ends the API session after a governed read failure', () =>
  Effect.gen(function* failureCleanup() {
    const calls: string[] = [];
    const client: Pick<SeedClient, 'call' | 'signOut'> = {
      call: () => Effect.fail(new DemoSeedError({ reason: 'read denied' })),
      signOut: Effect.sync(() => {
        calls.push('signOut');
      }),
    };
    const result = yield* withNewsletterEvidenceClient(Effect.succeed(client), target, PURPOSE, NOTICE).pipe(
      Effect.exit,
    );
    expect(result._tag).toBe('Failure');
    expect(calls).toEqual(['signOut']);
  }).pipe(Effect.provide(noNetwork)),
);
it.effect('ends the API session on interruption without retrying the read', () =>
  Effect.gen(function* interruptionCleanup() {
    const calls: string[] = [];
    const client: Pick<SeedClient, 'call' | 'signOut'> = {
      call: () =>
        Effect.sync(() => {
          calls.push('read');
        }).pipe(Effect.andThen(Effect.never)),
      signOut: Effect.sync(() => {
        calls.push('signOut');
      }),
    };
    const fiber = yield* withNewsletterEvidenceClient(Effect.succeed(client), target, PURPOSE, NOTICE).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    expect(calls).toEqual(['read', 'signOut']);
  }).pipe(Effect.provide(noNetwork)),
);
