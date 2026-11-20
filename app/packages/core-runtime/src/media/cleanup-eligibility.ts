import { and, eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { actionInvocations, evidenceReferences, mediaAssets, mediaLinks } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { mediaUnavailable } from './errors.ts';
import { MediaAssetIdSchema, MediaTenantIdSchema } from './identity.ts';
import { logMediaRecovery, mediaRecoveryRef } from './recovery-log.ts';
import { deriveMediaStorageKey, MediaStorageKeySchema } from './storage-key.ts';

/*
 * The eligibility of a technical object for cleanup. This is a CHECK, never an action: Core Media has no delete
 * (the provider port has none, and no Action removes bytes), so nothing here removes anything and no code path
 * of this module can. What it decides is whether a future, separately approved procedure would be allowed to
 * touch one object (docs: cleanup-procedure). The answer is "eligible" only when EVERY condition is proven and a
 * single unproven or present one refuses, so the artifact stays for reconciliation:
 * - the target is verified: the key is the one derived from the named intent, nothing else;
 * - no Media Asset row holds the storage identity or the intent id (not confirmed, not open, not failed evidence);
 * - no media link, no evidence reference and no Action Invocation names the intent;
 * - no provider-side retention or hold is recorded as present, and the absence is attested, not assumed;
 * - the caller holds the existing technical authority, verified by the composing host.
 * Under the reserve-first protocol every object Core wrote belongs to a reserved asset row, so in practice an
 * object is eligible only when it was never part of any Core intent.
 */

const CleanupRefusalSchema = Schema.Literals([
  /** The key is not the one derived from the named tenant and intent: the target cannot be told apart from another. */
  'target_unverified',
  /** The object is the bytes of a confirmed (ready) Media Asset. */
  'confirmed_asset',
  /** An asset row is open or uncertain (uploaded or scanning): its intent may still complete. */
  'open_intent',
  /** The asset closed as failed: its bytes are evidence of proven corruption or of a closed intent. */
  'failed_asset_evidence',
  /** More than one asset row names the storage identity: an ambiguity is never a license. */
  'ambiguous_storage_identity',
  /** A Media Link points at the asset: it is used or shared. */
  'linked',
  /** An Evidence Reference points at the asset. */
  'evidence_reference',
  /** An Action Invocation of the intent exists, in any state: it may be open or uncertain. */
  'action_invocation_present',
  /** Provider-side retention or hold is recorded, or its absence is not attested. */
  'protection_unproven',
  /** The caller's technical authority is not verified. */
  'authority_unverified',
]);
export type MediaCleanupRefusal = typeof CleanupRefusalSchema.Type;

const ProviderProtectionSchema = Schema.Literals(['none_recorded', 'recorded', 'unknown']);
const TechnicalAuthoritySchema = Schema.Literals(['verified', 'absent']);

/** The intent the object is said to belong to, and the object itself. Names, never a locator taken on trust. */
const CleanupTargetSchema = Schema.Struct({
  mediaAssetId: MediaAssetIdSchema,
  storageKey: MediaStorageKeySchema,
  storageProvider: Schema.String,
  tenantId: MediaTenantIdSchema,
});
type CleanupTarget = typeof CleanupTargetSchema.Type;

/** What the database says about the intent. Each field is the whole truth, not a sample. */
export interface MediaCleanupFacts {
  readonly assetStatusesAtStorageIdentity: readonly string[];
  readonly assetStatusesById: readonly string[];
  readonly evidenceReferenceCount: number;
  readonly invocationCount: number;
  readonly linkCount: number;
}

export interface MediaCleanupAssessmentInput {
  /** The attestation of the composing host that no provider-side retention or hold exists, or that one does. */
  readonly authority: typeof TechnicalAuthoritySchema.Type;
  readonly facts: MediaCleanupFacts;
  readonly providerProtection: typeof ProviderProtectionSchema.Type;
  readonly target: CleanupTarget;
}

export type MediaCleanupAssessment =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly refusals: readonly MediaCleanupRefusal[] };

const statusRefusal = (status: string): MediaCleanupRefusal => {
  if (status === 'ready') {
    return 'confirmed_asset';
  }
  return status === 'failed' ? 'failed_asset_evidence' : 'open_intent';
};

/** Every refusal that applies, never just the first, so a refusal is as informative as it can be. */
export const assessTemporaryObjectCleanup = (input: MediaCleanupAssessmentInput): MediaCleanupAssessment => {
  const { authority, facts, providerProtection, target } = input;
  const refusals = new Set<MediaCleanupRefusal>();
  const derived = deriveMediaStorageKey({ mediaAssetId: target.mediaAssetId, tenantId: target.tenantId });
  if (derived !== target.storageKey) {
    refusals.add('target_unverified');
  }
  for (const status of [...facts.assetStatusesAtStorageIdentity, ...facts.assetStatusesById]) {
    refusals.add(statusRefusal(status));
  }
  if (facts.assetStatusesAtStorageIdentity.length > 1) {
    refusals.add('ambiguous_storage_identity');
  }
  if (facts.linkCount > 0) {
    refusals.add('linked');
  }
  if (facts.evidenceReferenceCount > 0) {
    refusals.add('evidence_reference');
  }
  if (facts.invocationCount > 0) {
    refusals.add('action_invocation_present');
  }
  if (providerProtection !== 'none_recorded') {
    refusals.add('protection_unproven');
  }
  if (authority !== 'verified') {
    refusals.add('authority_unverified');
  }
  return refusals.size === 0 ? { eligible: true } : { eligible: false, refusals: [...refusals] };
};

const countOf = (rows: readonly { readonly count: number }[]): number => rows[0]?.count ?? 0;

/**
 * Reads the facts of one intent in the trusted tenant scope: every asset row at the storage identity and by id,
 * and the number of links, evidence references and Action Invocations that name it. A read that fails is
 * unavailable, which refuses nothing and allows nothing: no assessment is made without the facts.
 */
export const readMediaCleanupFacts = Effect.fn('MediaCleanupEligibility.readFacts')(function* readMediaCleanupFacts(
  transaction: ScopedTransactionExecutor,
  target: CleanupTarget,
) {
  const { mediaAssetId, storageKey, storageProvider, tenantId } = target;
  const count = sql<number>`count(*)::int`;
  const read = Effect.all(
    {
      assetsAtStorageIdentity: transaction
        .select({ status: mediaAssets.processingStatus })
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.tenantId, tenantId),
            eq(mediaAssets.storageProvider, storageProvider),
            eq(mediaAssets.storageKey, storageKey),
          ),
        ),
      assetsById: transaction
        .select({ status: mediaAssets.processingStatus })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.tenantId, tenantId), eq(mediaAssets.mediaAssetId, mediaAssetId))),
      evidence: transaction
        .select({ count })
        .from(evidenceReferences)
        .where(and(eq(evidenceReferences.tenantId, tenantId), eq(evidenceReferences.mediaAssetId, mediaAssetId))),
      invocations: transaction
        .select({ count })
        .from(actionInvocations)
        .where(and(eq(actionInvocations.tenantId, tenantId), eq(actionInvocations.actionInvocationId, mediaAssetId))),
      links: transaction
        .select({ count })
        .from(mediaLinks)
        .where(and(eq(mediaLinks.tenantId, tenantId), eq(mediaLinks.mediaAssetId, mediaAssetId))),
    },
    { concurrency: 1 },
  );
  const rows = yield* read.pipe(
    Effect.mapError((cause) => mediaUnavailable('The cleanup facts could not be read', cause)),
  );
  return {
    assetStatusesAtStorageIdentity: rows.assetsAtStorageIdentity.map(({ status }) => status),
    assetStatusesById: rows.assetsById.map(({ status }) => status),
    evidenceReferenceCount: countOf(rows.evidence),
    invocationCount: countOf(rows.invocations),
    linkCount: countOf(rows.links),
  } satisfies MediaCleanupFacts;
});

/**
 * Reads the facts, assesses them and logs the redacted result. It deletes nothing and schedules nothing: the
 * answer is only ever evidence for a person or a separately approved procedure.
 */
export const checkTemporaryObjectCleanup = Effect.fn('MediaCleanupEligibility.check')(
  function* checkTemporaryObjectCleanup(
    transaction: ScopedTransactionExecutor,
    input: Omit<MediaCleanupAssessmentInput, 'facts'>,
  ) {
    // A target of another tenant than the trusted scope cannot be told apart from a foreign object: no facts are read.
    const assessment: MediaCleanupAssessment =
      input.target.tenantId === transaction.scope.tenantId
        ? assessTemporaryObjectCleanup({ ...input, facts: yield* readMediaCleanupFacts(transaction, input.target) })
        : { eligible: false, refusals: ['target_unverified'] };
    yield* logMediaRecovery({
      category: assessment.eligible ? 'eligible' : 'refused',
      operation: 'cleanup_check',
      ref: mediaRecoveryRef(input.target.storageKey),
    });
    return assessment;
  },
);
