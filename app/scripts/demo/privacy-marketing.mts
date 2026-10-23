#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import {
  CreateProcessingPurposePayloadSchema,
  CreateProcessingPurposeResultSchema,
  CreateNoticeVersionPayloadSchema,
  CreateNoticeVersionResultSchema,
  ProcessingPurposesRequestSchema,
  ProcessingPurposesResponseSchema,
  NoticeVersionsRequestSchema,
  NoticeVersionsResponseSchema,
} from '@app/privacy/api';
import { Config, Console, DateTime, Effect, Exit, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';
import { akrosDemoLegalEntityId, demoId, demoTenantId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';
import type { SeedClient, SeedTarget } from './seed-client.mts';

const meaning =
  'Volitelné zasílání novinek a obchodních nabídek e-mailem; souhlas lze kdykoli odvolat v zákaznickém účtu.';
const wording =
  'Souhlasím se zasíláním novinek a obchodních nabídek AKROS na svůj kontaktní e-mail. Souhlas je dobrovolný, není podmínkou nákupu a mohu jej kdykoli odvolat v části Můj účet. Odvolání neovlivní zákonnost předchozího zpracování.';
const contentIdentity = 'commerce.email-marketing.cs.v1';
const marketingScopeKey = 'commerce.email-marketing';
// Durable operation evidence; an in-flight checkpoint must never be deleted to retry an unknown write.
const StoredCheckpointSchema = Schema.Struct({
  legalEntityId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacySetupLegalEntityId'))),
  notice: Schema.OptionFromNullOr(CreateNoticeVersionResultSchema),
  phase: Schema.Literals(['EMPTY', 'PURPOSE_PENDING', 'PURPOSE_CREATED', 'NOTICE_PENDING', 'COMPLETE']),
  purpose: Schema.OptionFromNullOr(CreateProcessingPurposeResultSchema),
  shellUrl: Schema.String,
  tenantId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacySetupTenantId'))),
});
type Checkpoint = typeof StoredCheckpointSchema.Type;
const configuration = Config.all({
  email: Config.String('ONTOS_DEMO_SEED_EMAIL'),
  governanceOwnerId: Config.schema(Schema.String.check(Schema.isUUID()), 'ONTOS_DEMO_SEED_GOVERNANCE_OWNER_ID'),
  legalEntityId: Config.String('ONTOS_DEMO_SEED_LEGAL_ENTITY_ID'),
  password: Config.Redacted('ONTOS_DEMO_SEED_PASSWORD'),
  shellUrl: Config.String('ONTOS_DEMO_SEED_URL'),
  tenantId: Config.String('ONTOS_DEMO_SEED_TENANT_ID'),
});
const persistCheckpoint = (path: string, checkpoint: Checkpoint) =>
  Effect.gen(function* persist() {
    const fs = yield* FileSystem.FileSystem;
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(StoredCheckpointSchema))(checkpoint);
    yield* fs.writeFileString(path, json, { mode: 0o600 });
    yield* fs.chmod(path, 0o600);
  });
const samePurposeRecord = Schema.toEquivalence(CreateProcessingPurposeResultSchema);
const sameNoticeRecord = Schema.toEquivalence(CreateNoticeVersionResultSchema);
const verifyRecords = (client: SeedClient, checkpoint: Checkpoint) =>
  Effect.gen(function* verify() {
    if (Option.isNone(checkpoint.purpose) || Option.isNone(checkpoint.notice)) {
      return yield* new DemoSeedError({ reason: 'Privacy setup checkpoint is incomplete.' });
    }
    const purposeRecord = checkpoint.purpose.value;
    const noticeRecord = checkpoint.notice.value;
    const now = DateTime.formatIso(yield* DateTime.now);
    const purposes = yield* client.call(
      'privacy',
      '/reads/processing-purposes',
      ProcessingPurposesRequestSchema,
      {
        at: now,
        includeRetired: false,
        purposeRefs: [purposeRecord.purposeRef],
      },
      ProcessingPurposesResponseSchema,
    );
    const notices = yield* client.call(
      'privacy',
      '/reads/notice-versions',
      NoticeVersionsRequestSchema,
      {
        asOf: now,
        languages: ['cs'],
        noticeRefs: [noticeRecord.noticeRef.resourceId],
      },
      NoticeVersionsResponseSchema,
    );
    const purpose = purposes.items.find(
      (item) => item.purpose.purposeRef.resourceId === purposeRecord.purposeRef.resourceId,
    );
    const notice = notices.items.find((item) => item.versionId === noticeRecord.versionId);
    if (
      purpose?.effectiveVersion === null ||
      purpose?.effectiveVersion === undefined ||
      notice === undefined ||
      !samePurposeRecord(purpose.purpose, purposeRecord) ||
      !sameNoticeRecord(notice, noticeRecord) ||
      purpose.effectiveVersion.versionId !== purposeRecord.versions.at(0)?.versionId ||
      purpose.purpose.businessCode !== 'EMAIL_MARKETING' ||
      purpose.effectiveVersion.meaning !== meaning ||
      purpose.effectiveVersion.requiredConsentDimensions?.includes('COMMUNICATION_CHANNEL') !== true ||
      notice.contentIdentity !== contentIdentity ||
      notice.wording !== wording
    ) {
      return yield* new DemoSeedError({
        reason:
          'Native Privacy records do not match the declared email marketing setup. No environment configuration was published.',
      });
    }
    return { notice, purpose: purpose.purpose, version: purpose.effectiveVersion };
  });
export const seedPrivacyMarketing = (
  client: SeedClient,
  target: SeedTarget,
  governanceOwnerId: string,
  checkpointPath: string,
) =>
  Effect.gen(function* seed() {
    const fs = yield* FileSystem.FileSystem;
    if (target.tenantId !== demoTenantId || target.legalEntityId !== akrosDemoLegalEntityId) {
      return yield* new DemoSeedError({
        reason: 'Privacy marketing seed is restricted to the declared demo tenant and commerce legal entity.',
      });
    }
    let checkpoint: Checkpoint = yield* fs
      .exists(checkpointPath)
      .pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs
                .readFileString(checkpointPath)
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCheckpointSchema))))
            : Effect.succeed({ notice: Option.none(), phase: 'EMPTY' as const, purpose: Option.none(), ...target }),
        ),
      );
    if (
      checkpoint.tenantId !== target.tenantId ||
      checkpoint.legalEntityId !== target.legalEntityId ||
      checkpoint.shellUrl !== target.shellUrl
    ) {
      return yield* new DemoSeedError({ reason: 'Checkpoint belongs to another exact owner scope.' });
    }
    if (checkpoint.phase === 'PURPOSE_PENDING' || checkpoint.phase === 'NOTICE_PENDING') {
      return yield* new DemoSeedError({
        reason:
          'A native Privacy write has an unknown outcome. Reconcile its Action audit before continuing; do not remove this checkpoint or repeat the write.',
      });
    }
    if (checkpoint.phase === 'EMPTY') {
      checkpoint = { ...checkpoint, phase: 'PURPOSE_PENDING' };
      yield* persistCheckpoint(checkpointPath, checkpoint);
      const purpose = yield* client.call(
        'privacy',
        '/privacy/actions/create-processing-purpose',
        CreateProcessingPurposePayloadSchema,
        {
          businessCode: 'EMAIL_MARKETING',
          effectiveFrom: DateTime.formatIso(yield* DateTime.now),
          governanceOwnerId,
          materialScope: {
            applicabilityKey: marketingScopeKey,
            consentRequired: true,
            consentScopeKey: marketingScopeKey,
            controllerRef: target.legalEntityId,
            dataCategoryRefs: ['party.contact-email'],
            processingScopeRef: marketingScopeKey,
            recipientRefs: [],
          },
          meaning,
          requiredConsentDimensions: ['COMMUNICATION_CHANNEL'],
        },
        CreateProcessingPurposeResultSchema,
        true,
      );
      checkpoint = { ...checkpoint, phase: 'PURPOSE_CREATED', purpose: Option.some(purpose) };
      yield* persistCheckpoint(checkpointPath, checkpoint);
    }
    if (checkpoint.phase === 'PURPOSE_CREATED') {
      const purpose = Option.getOrUndefined(checkpoint.purpose);
      const version = purpose?.versions.at(0);
      if (purpose === undefined || version === undefined) {
        return yield* new DemoSeedError({ reason: 'Native Purpose Version is missing from setup checkpoint.' });
      }
      checkpoint = { ...checkpoint, phase: 'NOTICE_PENDING' };
      yield* persistCheckpoint(checkpointPath, checkpoint);
      // This notice is a canonical wording/template, not evidence that a customer received it.
      // Commerce creates and displays an exact subject-scoped native instance before acknowledgement.
      const notice = yield* client.call(
        'privacy',
        '/privacy/actions/create-notice-version',
        CreateNoticeVersionPayloadSchema,
        {
          input: {
            applicableScope: {
              facts: [
                { dimension: 'CONTROLLER_SCOPE', value: target.legalEntityId },
                { dimension: 'PROCESSING_PURPOSE', value: purpose.purposeRef.resourceId },
                { dimension: 'PROCESSING_PURPOSE_VERSION', value: version.versionId },
                { dimension: 'CHANNEL', value: 'EMAIL' },
              ],
              operation: 'CONSENT_WRITE',
              processingScopeRef: {
                scopeId: 'commerce.email-marketing.template',
                scopeType: 'privacy.processing-scope',
              },
            },
            contentIdentity,
            evidenceArtifactRef: null,
            language: 'cs',
            wording,
          },
          noticeId: demoId('privacy.notice', 'email-marketing-template'),
        },
        CreateNoticeVersionResultSchema,
        true,
      );
      checkpoint = { ...checkpoint, notice: Option.some(notice), phase: 'COMPLETE' };
      yield* persistCheckpoint(checkpointPath, checkpoint);
    }
    return yield* verifyRecords(client, checkpoint);
  });
const main = (apply: boolean, checkpoint: string, envFile: string) =>
  Effect.gen(function* run() {
    const { email, governanceOwnerId, password, ...target } = yield* configuration;
    if (!checkpoint.startsWith('/Volumes/') || !envFile.startsWith('/Volumes/')) {
      return yield* new DemoSeedError({ reason: 'Use explicit external-volume checkpoint and environment paths.' });
    }
    const client = yield* connectSeedClient(target, email, password);
    if (!apply) {
      return yield* Console.log(
        'Read-only seed admission passed. --apply creates native EMAIL_MARKETING purpose and canonical Czech notice; it never grants customer consent.',
      );
    }
    const result = yield* seedPrivacyMarketing(client, target, governanceOwnerId, checkpoint);
    const values = new Map([
      ['COMMERCE_MARKETING_PURPOSE_ID', result.purpose.purposeRef.resourceId],
      ['COMMERCE_MARKETING_PURPOSE_VERSION_ID', result.version.versionId],
      ['COMMERCE_MARKETING_NOTICE_ID', result.notice.noticeRef.resourceId],
      ['COMMERCE_MARKETING_NOTICE_VERSION_ID', result.notice.versionId],
      ['COMMERCE_MARKETING_CONTROLLER_REF', target.legalEntityId],
    ]);
    const fs = yield* FileSystem.FileSystem;
    const original = (yield* fs.exists(envFile)) ? yield* fs.readFileString(envFile) : '';
    const retained = original
      .split('\n')
      .filter((line) => !values.has(line.split('=', 1).at(0) ?? ''))
      .join('\n')
      .replace(/\n+$/u, '');
    const appended = [...values].map(([key, value]) => `${key}=${value}`).join('\n');
    yield* fs.writeFileString(envFile, `${retained}\n${appended}\n`, { mode: 0o600 });
    yield* fs.chmod(envFile, 0o600);
    return yield* Console.log(
      'Native Privacy purpose and notice confirmed by owner re-read; actual returned references published. Customer subject bindings and notice provisions are created only by the admitted account flow.',
    );
  });
const command = Command.make(
  'privacy-marketing-seed',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    checkpoint: Flag.String('checkpoint'),
    envFile: Flag.String('env-file'),
  },
  ({ apply, checkpoint, envFile }) =>
    main(apply, checkpoint, envFile).pipe(
      Effect.tapError(() =>
        Console.error('Privacy marketing setup stopped. No credentials or owner response bodies are logged.'),
      ),
    ),
);
if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        ),
      ),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
