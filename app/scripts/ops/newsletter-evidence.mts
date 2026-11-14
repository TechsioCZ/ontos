import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  NoticeVersionsRequestSchema,
  NoticeVersionsResponseSchema,
  ProcessingPurposesRequestSchema,
  ProcessingPurposesResponseSchema,
} from '@app/privacy/api';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { akrosDemoLegalEntityId, demoTenantId } from '../demo/fixture-ids.mts';
import { privacyMarketingOperator } from '../demo/permissions.mts';
import { connectSeedClient } from '../demo/seed-client.mts';
import type { SeedClient, SeedTarget } from '../demo/seed-client.mts';
import { DEFAULT_PASSWORD } from './stage-demo-verify.mjs';

export const NEWSLETTER_STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
class NewsletterEvidenceInvalid extends Schema.TaggedError<NewsletterEvidenceInvalid>()('NewsletterEvidenceInvalid', {
  reason: Schema.String,
}) {}
const ResourceUuid = Schema.String.check(Schema.isUUID());
const configuration = Config.all({
  ci: Config.schema(Schema.Literal('true'), 'CI'),
  noticeId: Config.schema(ResourceUuid, 'NEWSLETTER_NOTICE_ID'),
  purposeId: Config.schema(ResourceUuid, 'NEWSLETTER_PURPOSE_ID'),
  runnerTemp: Config.String('RUNNER_TEMP'),
  shellUrl: Config.String('STAGE_SHELL_URL'),
});
const checkTarget = (target: SeedTarget) =>
  target.shellUrl === NEWSLETTER_STAGE_ORIGIN &&
  target.tenantId === demoTenantId &&
  target.legalEntityId === akrosDemoLegalEntityId
    ? Effect.void
    : Effect.fail(new NewsletterEvidenceInvalid({ reason: 'Only the exact stage demo Privacy scope is allowed.' }));

const requirePurpose = (purposes: typeof ProcessingPurposesResponseSchema.Type, purposeId: string) =>
  Effect.gen(function* requireExactPurpose() {
    const [item] = purposes.items;
    const version = item?.effectiveVersion;
    if (
      purposes.items.length !== 1 ||
      purposes.missingRefs.length !== 0 ||
      item?.purpose.purposeRef.resourceId !== purposeId ||
      item.purpose.purposeRef.tenantId !== demoTenantId ||
      item.purpose.legalEntityId !== akrosDemoLegalEntityId ||
      item.purpose.businessCode !== 'EMAIL_MARKETING' ||
      item.purpose.lifecycle !== 'ACTIVE' ||
      version?.materialScope?.controllerRef !== akrosDemoLegalEntityId ||
      version.materialScope.consentScopeKey !== 'commerce.email-marketing' ||
      !version.materialScope.consentRequired ||
      version.requiredConsentDimensions?.includes('COMMUNICATION_CHANNEL') !== true
    ) {
      return yield* new NewsletterEvidenceInvalid({
        reason: 'The exact current native demo marketing purpose is unavailable.',
      });
    }
    return version;
  });

/** Only two exact, company-scoped public catalog reads. IDs come from native publication, never Commerce. */
export const readNewsletterEvidence = (
  client: Pick<SeedClient, 'call'>,
  target: SeedTarget,
  purposeId: string,
  noticeId: string,
) =>
  Effect.gen(function* readPublicPrivacyCatalog() {
    yield* checkTarget(target);
    yield* Schema.decodeUnknownEffect(ResourceUuid)(purposeId);
    yield* Schema.decodeUnknownEffect(ResourceUuid)(noticeId);
    const now = DateTime.formatIso(yield* DateTime.now);
    const purposes = yield* client.call(
      'privacy',
      '/reads/processing-purposes',
      ProcessingPurposesRequestSchema,
      {
        at: now,
        includeRetired: false,
        purposeRefs: [
          {
            moduleId: 'privacy.core',
            resourceId: purposeId,
            resourceType: 'privacy.core.processing-purpose',
            tenantId: demoTenantId,
          },
        ],
      },
      ProcessingPurposesResponseSchema,
    );
    const version = yield* requirePurpose(purposes, purposeId);
    const notices = yield* client.call(
      'privacy',
      '/reads/notice-versions',
      NoticeVersionsRequestSchema,
      { asOf: now, languages: ['cs'], noticeRefs: [noticeId] },
      NoticeVersionsResponseSchema,
    );
    const [notice] = notices.items;
    const expectedFacts = [
      { dimension: 'CONTROLLER_SCOPE', value: akrosDemoLegalEntityId },
      { dimension: 'PROCESSING_PURPOSE', value: purposeId },
      { dimension: 'PROCESSING_PURPOSE_VERSION', value: version.versionId },
      { dimension: 'CHANNEL', value: 'EMAIL' },
    ];
    if (
      notices.items.length !== 1 ||
      notice?.noticeRef.resourceId !== noticeId ||
      notice.noticeRef.tenantId !== demoTenantId ||
      notice.language !== 'cs' ||
      notice.contentIdentity !== 'commerce.email-marketing.sroubshop.cs.v1' ||
      notice.applicableScope.operation !== 'CONSENT_WRITE' ||
      notice.applicableScope.processingScopeRef.scopeId !== 'commerce.email-marketing.template' ||
      notice.applicableScope.processingScopeRef.scopeType !== 'privacy.processing-scope' ||
      notice.applicableScope.facts.length !== expectedFacts.length ||
      !expectedFacts.every(
        (fact) =>
          notice.applicableScope.facts.filter(
            (actual) => actual.dimension === fact.dimension && actual.value === fact.value,
          ).length === 1,
      )
    ) {
      return yield* new NewsletterEvidenceInvalid({ reason: 'The exact native demo Czech notice is unavailable.' });
    }
    // Encoding these public contracts cannot retain client/session credentials or unrelated response properties.
    return {
      notices: yield* Schema.encodeEffect(Schema.fromJsonString(NoticeVersionsResponseSchema))(notices),
      purposes: yield* Schema.encodeEffect(Schema.fromJsonString(ProcessingPurposesResponseSchema))(purposes),
    };
  });

/** Owns this API session on success, typed failure, defect and interruption. */
export const withNewsletterEvidenceClient = <E, R>(
  acquire: Effect.Effect<Pick<SeedClient, 'call' | 'signOut'>, E, R>,
  target: SeedTarget,
  purposeId: string,
  noticeId: string,
) =>
  checkTarget(target).pipe(
    Effect.andThen(
      Effect.acquireUseRelease(
        acquire,
        (client) => readNewsletterEvidence(client, target, purposeId, noticeId),
        (client) => client.signOut.pipe(Effect.orDie),
      ),
    ),
  );

const run = Effect.gen(function* produceNewsletterEvidence() {
  const settings = yield* configuration;
  const target = { legalEntityId: akrosDemoLegalEntityId, shellUrl: settings.shellUrl, tenantId: demoTenantId };
  yield* checkTarget(target);
  if (privacyMarketingOperator.legalEntityId !== target.legalEntityId) {
    return yield* new NewsletterEvidenceInvalid({
      reason: 'The source-owned operator must belong to the exact demo company.',
    });
  }
  if (!path.isAbsolute(settings.runnerTemp)) {
    return yield* new NewsletterEvidenceInvalid({ reason: 'RUNNER_TEMP must be an absolute CI-owned directory.' });
  }
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(settings.runnerTemp, 'newsletter-native');
  const purposesPath = path.join(directory, 'processing-purposes.json');
  const noticesPath = path.join(directory, 'notice-versions.json');
  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
  // Never let a failed new observation reuse files from a previous attempt on this runner.
  yield* fs.remove(purposesPath, { force: true });
  yield* fs.remove(noticesPath, { force: true });
  const result = yield* withNewsletterEvidenceClient(
    connectSeedClient(target, privacyMarketingOperator.email, DEFAULT_PASSWORD),
    target,
    settings.purposeId,
    settings.noticeId,
  );
  yield* fs.writeFileString(purposesPath, result.purposes, { mode: 0o600 });
  yield* fs.writeFileString(noticesPath, result.notices, { mode: 0o600 });
  return yield* Console.log('Saved the two exact public Privacy catalog reads for the demo newsletter proof.');
});
if (import.meta.main) {
  NodeRuntime.runMain(
    run.pipe(
      Effect.tapCause(() =>
        Console.error('Native newsletter evidence is unavailable; the newsletter proof remains unverified.'),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
    { disableErrorReporting: true },
  );
}
