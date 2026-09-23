import type { Effect, Option } from 'effect';
import { Schema } from 'effect';

import type { CatalogLocalOverrideOperation } from '../domain/catalog-local-override.ts';
import type { CatalogExternalSourceRecordRef } from '../../shared/domain/external-identifier-boundary.ts';
import type { CatalogResolvedExternalTarget } from '../../shared/domain/external-target-resolution.ts';
import type { CatalogSourceAuthorityRequest } from '../domain/catalog-source-authority.ts';
import type {
  CatalogCurrentResolution,
  CatalogFactAdmission,
  CatalogFactScope,
  CatalogLocalOverride,
  CatalogSourceAssertion,
  CatalogSourceAuthority,
} from '../domain/catalog-source-resolution.ts';

export class CatalogSourceResolutionUnavailable extends Schema.TaggedError<CatalogSourceResolutionUnavailable>()(
  'CatalogSourceResolutionUnavailable',
  { code: Schema.Literal('catalog_source_resolution_unavailable'), reason: Schema.String },
) {}

type CatalogAssertionAppendOutcome =
  | { readonly status: 'ALREADY_PRESENT' }
  | { readonly status: 'INSERTED' }
  | { readonly reason: string; readonly status: 'CONFLICT' };

type CatalogOverrideAppendOutcome =
  | { readonly status: 'APPLIED' }
  | { readonly activeRevision: bigint | null; readonly reason: string; readonly status: 'CONFLICT' };

/** Immutable accepted-base evidence and the append-only Local Override revision history. */
export interface CatalogSourceResolutionPorts<Value> {
  readonly appendAcceptedBase: (input: {
    readonly assertion: CatalogSourceAssertion<Value>;
    readonly authority: CatalogSourceAuthority;
    readonly captureConfirmed: boolean;
    readonly sourceRecord: CatalogExternalSourceRecordRef;
    readonly targetResolution: CatalogResolvedExternalTarget;
  }) => Effect.Effect<CatalogAssertionAppendOutcome, CatalogSourceResolutionUnavailable>;
  readonly appendOverrideRevision: (input: {
    readonly expectedRevision: bigint | null;
    readonly override: CatalogLocalOverride<Value>;
  }) => Effect.Effect<CatalogOverrideAppendOutcome, CatalogSourceResolutionUnavailable>;
  readonly readAcceptedBases: (
    scope: CatalogFactScope,
  ) => Effect.Effect<readonly CatalogSourceAssertion<Value>[], CatalogSourceResolutionUnavailable>;
  readonly readOverrides: (
    scope: CatalogFactScope,
  ) => Effect.Effect<readonly CatalogLocalOverride<Value>[], CatalogSourceResolutionUnavailable>;
}

/** The deployment fact→authority map that #422 deliberately does not own. */
export interface CatalogSourceAuthorityPorts {
  readonly resolveAuthority: (
    request: CatalogSourceAuthorityRequest,
  ) => Effect.Effect<Option.Option<CatalogSourceAuthority>, CatalogSourceResolutionUnavailable>;
}

/** Owner-local evidence for Catalog fact ownership, override permission, and value validity. */
export interface CatalogFactAdmissionPorts<Value> {
  readonly authorizeOverrideOperation: (input: {
    readonly operation: CatalogLocalOverrideOperation;
    readonly permissionKey: string;
    readonly principalId: string;
    readonly scope: CatalogFactScope;
  }) => Effect.Effect<boolean, CatalogSourceResolutionUnavailable>;
  readonly isAssertionValueValid: (input: {
    readonly assertion: CatalogSourceAssertion<Value>;
    readonly scope: CatalogFactScope;
  }) => Effect.Effect<boolean, CatalogSourceResolutionUnavailable>;
  readonly isOverrideValueValid: (input: {
    readonly principalId: string;
    readonly scope: CatalogFactScope;
    readonly value: Value;
  }) => Effect.Effect<boolean, CatalogSourceResolutionUnavailable>;
  readonly readAdmission: (
    scope: CatalogFactScope,
  ) => Effect.Effect<Option.Option<CatalogFactAdmission>, CatalogSourceResolutionUnavailable>;
}

const CatalogResolvedCurrentChangeCauseSchema = Schema.Literals([
  'IMPORT_ACCEPTED',
  'OVERRIDE_ACTIVATED',
  'OVERRIDE_CHANGED',
  'OVERRIDE_RELEASED',
]);
export type CatalogResolvedCurrentChangeCause = typeof CatalogResolvedCurrentChangeCauseSchema.Type;

export type CatalogResolvedCurrentSourceRevision =
  | {
      readonly assertionId: string;
      readonly issuerSystemId: string;
      readonly kind: 'ACCEPTED_BASE';
      readonly sourceRecordId: string;
      readonly sourceRevision: bigint;
    }
  | {
      readonly evidenceRef: string;
      readonly kind: 'LOCAL_OVERRIDE';
      readonly revision: bigint;
    };

/**
 * The #480 seam. A committed operation announces a resolved-Current change only when the owner can
 * prove both the previous and the next resolved Current; the emitter must never be called for a
 * base-only update hidden beneath an unchanged active override.
 */
export interface CatalogResolvedCurrentEventPorts<Value> {
  readonly emitResolvedCurrentChanged: (input: {
    readonly cause: CatalogResolvedCurrentChangeCause;
    readonly next: CatalogCurrentResolution<Value>;
    readonly previous: CatalogCurrentResolution<Value>;
    readonly scope: CatalogFactScope;
    readonly sourceRevision: CatalogResolvedCurrentSourceRevision;
  }) => Effect.Effect<void, CatalogSourceResolutionUnavailable>;
}
