import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Data, DateTime, Effect, Option, Schema } from 'effect';

import { LanguagePolicyStoreUnavailable } from '../../shared/language-policy-errors.ts';
import { LanguageModeSchema, LanguagePolicyVersionIdSchema } from '../../shared/language-policy.ts';
import {
  TemplateActivationIdSchema,
  TemplateLegalEntityIdSchema,
  TemplatePrincipalIdSchema,
  TemplateRevisionIdSchema,
  TemplateScopeKeySchema,
  TemplateTypeIdSchema,
} from '../../shared/template-revision.ts';
import type { TemplateIdentity } from '../../shared/template-revision.ts';
import { TemplateStoreUnavailable } from '../../shared/template-revision-errors.ts';
import type {
  LanguageModeVersionRecord,
  LanguagePolicyPortContract,
} from '../services/language-policy-port.service.ts';
import type {
  TemplateActivationRecord,
  TemplateInvalidationRecord,
  TemplateReadPortContract,
  TemplateRevisionRecord,
  TemplateTypeRecord,
} from '../services/template-revision-port.service.ts';
import { readLanguagePolicySnapshotRoutine, workerReadTemplateSnapshotRoutine } from './communications-routines.ts';

/**
 * Read-only ports over scoped routines. The Action and the worker both decide language and verify template pins with
 * the SAME domain code (`resolveTemplatePin`, `verifyTemplatePinForHandoff`, `readLanguagePolicySnapshot`); only the
 * way the facts are read differs, because a worker has no transaction. Neither port can write.
 */

const templateUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new TemplateStoreUnavailable({
      code: 'template_store_unavailable',
      reason: 'The approved template revisions are unavailable',
    }),
    'cause',
    { enumerable: false, value: cause },
  );
const policyUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new LanguagePolicyStoreUnavailable({
      code: 'language_policy_store_unavailable',
      reason: 'The Tenant language mode is unavailable',
    }),
    'cause',
    { enumerable: false, value: cause },
  );

const instant = Schema.DateTimeUtcFromString;
const OwnPolicySchema = Schema.Struct({
  kind: Schema.Literal('own'),
  mode: LanguageModeSchema,
  policyVersionId: LanguagePolicyVersionIdSchema,
  setAt: instant,
  setByPrincipalId: TemplatePrincipalIdSchema,
  versionNumber: Schema.Number,
});
const PolicySnapshotSchema = Schema.Union([
  OwnPolicySchema,
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({ kind: Schema.Literal('unreadable') }),
]);

/** A read-only snapshot port has no write: asking for one is a defect of the caller, never a recoverable failure. */
class ReadOnlySnapshotPort extends Data.TaggedError('ReadOnlySnapshotPort')<{ readonly operation: string }> {}
const refusedWrite = () => Effect.die(new ReadOnlySnapshotPort({ operation: 'append' }));

/**
 * The Tenant's latest own language mode, read in the routine's OWN sub-transaction: an unreadable mode is the answer
 * `unreadable` (the port fails like a store failure, the domain records it and stops) and never aborts the caller.
 */
export const languagePolicyPortOverRoutines = (invoker: ScopedRoutineInvoker): LanguagePolicyPortContract => {
  const latest = invoker.invoke(readLanguagePolicySnapshotRoutine, []).pipe(
    Effect.mapError(policyUnavailable),
    Effect.flatMap((rows) =>
      Schema.decodeUnknownEffect(PolicySnapshotSchema)(rows[0]?.result).pipe(Effect.mapError(policyUnavailable)),
    ),
    Effect.flatMap((snapshot) => {
      if (snapshot.kind === 'unreadable') {
        return Effect.fail(policyUnavailable());
      }
      return Effect.succeed(
        snapshot.kind === 'none'
          ? Option.none<LanguageModeVersionRecord>()
          : Option.some<LanguageModeVersionRecord>({
              mode: snapshot.mode,
              policyVersionId: snapshot.policyVersionId,
              setAt: snapshot.setAt,
              setByPrincipalId: snapshot.setByPrincipalId,
              versionNumber: snapshot.versionNumber,
            }),
      );
    }),
  );
  return {
    append: refusedWrite,
    clockNow: Effect.sync(() => DateTime.nowUnsafe()),
    latest,
    lockTenant: Effect.void,
  };
};

const TypeRowSchema = Schema.Struct({
  channel: Schema.Literal('email'),
  createdAt: instant,
  createdByPrincipalId: TemplatePrincipalIdSchema,
  language: Schema.Literals(['cs', 'en']),
  legalEntityId: Schema.optionalKey(TemplateLegalEntityIdSchema),
  messageType: Schema.String,
  scopeKey: TemplateScopeKeySchema,
  templateTypeId: TemplateTypeIdSchema,
});
const ActivationRowSchema = Schema.Struct({
  activatedAt: instant,
  activatedByPrincipalId: TemplatePrincipalIdSchema,
  activationId: TemplateActivationIdSchema,
  activationReason: Schema.String,
  endedAt: Schema.optionalKey(instant),
  endedByPrincipalId: Schema.optionalKey(TemplatePrincipalIdSchema),
  endedKind: Schema.optionalKey(Schema.Literals(['replaced', 'deactivated', 'invalidated-unsafe'])),
  endReason: Schema.optionalKey(Schema.String),
  revisionId: TemplateRevisionIdSchema,
  scopeKey: TemplateScopeKeySchema,
  templateTypeId: TemplateTypeIdSchema,
});
const RevisionRowSchema = Schema.Struct({
  body: Schema.String,
  contentDigest: Schema.String,
  createdAt: instant,
  createdByPrincipalId: TemplatePrincipalIdSchema,
  optionalPlaceholders: Schema.Array(Schema.String),
  placeholdersUsed: Schema.Array(Schema.String),
  reason: Schema.String,
  requiredPlaceholders: Schema.Array(Schema.String),
  revisionId: TemplateRevisionIdSchema,
  revisionNumber: Schema.Number,
  subject: Schema.String,
  templateTypeId: TemplateTypeIdSchema,
});
const InvalidationRowSchema = Schema.Struct({
  invalidatedAt: instant,
  invalidatedByPrincipalId: TemplatePrincipalIdSchema,
  reason: Schema.String,
  revisionId: TemplateRevisionIdSchema,
});
const TemplateSnapshotSchema = Schema.Struct({
  activations: Schema.Array(ActivationRowSchema),
  invalidations: Schema.Array(InvalidationRowSchema),
  now: instant,
  revisions: Schema.Array(RevisionRowSchema),
  types: Schema.Array(TypeRowSchema),
});
type TemplateSnapshot = typeof TemplateSnapshotSchema.Type;

const identityOfRow = (row: typeof TypeRowSchema.Type): TemplateIdentity => ({
  channel: row.channel,
  language: row.language,
  messageType: row.messageType,
  scope:
    row.legalEntityId === undefined
      ? { kind: 'tenant' }
      : { kind: 'legal-entity', legalEntityId: TemplateLegalEntityIdSchema.make(row.legalEntityId) },
});

const activationOf = (row: typeof ActivationRowSchema.Type): TemplateActivationRecord => ({
  activatedAt: row.activatedAt,
  activatedByPrincipalId: row.activatedByPrincipalId,
  activationId: row.activationId,
  activationReason: row.activationReason,
  ending:
    row.endedAt === undefined ||
    row.endedKind === undefined ||
    row.endedByPrincipalId === undefined ||
    row.endReason === undefined
      ? Option.none()
      : Option.some({
          endedAt: row.endedAt,
          endedByPrincipalId: row.endedByPrincipalId,
          endedKind: row.endedKind,
          endReason: row.endReason,
        }),
  revisionId: row.revisionId,
  scopeKey: row.scopeKey,
  templateTypeId: row.templateTypeId,
});

const typeRecordOf = (row: typeof TypeRowSchema.Type): TemplateTypeRecord => ({
  createdAt: row.createdAt,
  createdByPrincipalId: row.createdByPrincipalId,
  identity: identityOfRow(row),
  templateTypeId: row.templateTypeId,
});

const covers = (activation: TemplateActivationRecord, at: DateTime.Utc) =>
  DateTime.isLessThanOrEqualTo(activation.activatedAt, at) &&
  Option.match(activation.ending, {
    onNone: () => true,
    onSome: (ending) => DateTime.isGreaterThan(ending.endedAt, at),
  });

const snapshotPort = (snapshot: TemplateSnapshot): TemplateReadPortContract => {
  const typeRecord = typeRecordOf;
  const activations = snapshot.activations.map(activationOf);
  return {
    activationsAt: (templateTypeId, at) =>
      Effect.succeed(
        activations.filter((activation) => activation.templateTypeId === templateTypeId && covers(activation, at)),
      ),
    clockNow: Effect.succeed(snapshot.now),
    findInvalidation: (revisionId): Effect.Effect<Option.Option<TemplateInvalidationRecord>> =>
      Effect.succeed(
        Option.fromNullishOr(snapshot.invalidations.find((row) => row.revisionId === revisionId)).pipe(
          Option.map((row) => ({
            invalidatedAt: row.invalidatedAt,
            invalidatedByPrincipalId: row.invalidatedByPrincipalId,
            reason: row.reason,
            revisionId: row.revisionId,
          })),
        ),
      ),
    findType: (identity) =>
      Effect.succeed(
        Option.fromNullishOr(
          snapshot.types.find(
            (row) =>
              row.language === identity.language &&
              row.channel === identity.channel &&
              row.messageType === identity.messageType &&
              (identity.scope.kind === 'tenant'
                ? row.legalEntityId === undefined
                : row.legalEntityId === identity.scope.legalEntityId),
          ),
        ).pipe(Option.map(typeRecord)),
      ),
    latestActivityAt: (templateTypeId) =>
      Effect.succeed(
        Option.fromNullishOr(
          activations
            .flatMap((activation) =>
              activation.templateTypeId === templateTypeId
                ? [
                    activation.activatedAt,
                    ...Option.match(activation.ending, { onNone: () => [], onSome: (ending) => [ending.endedAt] }),
                  ]
                : [],
            )
            .toSorted((left, right) => left.epochMilliseconds - right.epochMilliseconds)
            .at(-1),
        ),
      ),
    loadRevision: (revisionId) =>
      Effect.succeed(
        Option.fromNullishOr(snapshot.revisions.find((row) => row.revisionId === revisionId)).pipe(
          Option.map((row): TemplateRevisionRecord => row),
        ),
      ),
    loadType: (templateTypeId) =>
      Effect.succeed(
        Option.fromNullishOr(snapshot.types.find((row) => row.templateTypeId === templateTypeId)).pipe(
          Option.map(typeRecord),
        ),
      ),
    // A read-only snapshot holds no lock: the worker only verifies, it never writes a pin.
    lockTypeShared: () => Effect.void,
  };
};

/**
 * The template read port of one exact message type, channel and scope, over ONE consistent snapshot read in the
 * worker's scope. `pinnedRevisionId` makes the snapshot contain the pinned revision even when it is no longer active.
 */
export const readTemplatePortOverRoutines = (
  invoker: ScopedRoutineInvoker,
  identity: Omit<TemplateIdentity, 'language'>,
  pinnedRevisionId: string | undefined,
) =>
  invoker
    .invoke(workerReadTemplateSnapshotRoutine, [
      identity.messageType,
      identity.channel,
      identity.scope.kind === 'tenant' ? 'tenant' : `legal-entity:${identity.scope.legalEntityId}`,
      pinnedRevisionId ?? null,
    ])
    .pipe(
      Effect.mapError(templateUnavailable),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(TemplateSnapshotSchema)(rows[0]?.result).pipe(Effect.mapError(templateUnavailable)),
      ),
      Effect.map(snapshotPort),
    );
