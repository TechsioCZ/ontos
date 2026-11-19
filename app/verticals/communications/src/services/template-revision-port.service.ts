import { Context } from 'effect';
import type { Crypto, DateTime, Effect, Option } from 'effect';
import type { TemplateIdentity } from '../../shared/template-revision.ts';
import type { TemplateStoreUnavailable as TemplateStoreUnavailableClass } from '../../shared/template-revision-errors.ts';

type TemplateStoreUnavailable = InstanceType<typeof TemplateStoreUnavailableClass>;

export interface TemplateTypeRecord {
  readonly createdAt: DateTime.Utc;
  readonly createdByPrincipalId: string;
  readonly identity: TemplateIdentity;
  readonly optionalPlaceholders: readonly string[];
  readonly requiredPlaceholders: readonly string[];
  readonly templateTypeId: string;
}

export interface TemplateRevisionRecord {
  readonly body: string;
  readonly contentDigest: string;
  readonly createdAt: DateTime.Utc;
  readonly createdByPrincipalId: string;
  readonly placeholdersUsed: readonly string[];
  readonly reason: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly subject: string;
  readonly templateTypeId: string;
}

export interface TemplateActivationEnding {
  readonly endedAt: DateTime.Utc;
  readonly endedByPrincipalId: string;
  readonly endedKind: 'replaced' | 'deactivated' | 'invalidated-unsafe';
  readonly endReason: string;
}

export interface TemplateActivationRecord {
  readonly activatedAt: DateTime.Utc;
  readonly activatedByPrincipalId: string;
  readonly activationId: string;
  readonly activationReason: string;
  readonly ending: Option.Option<TemplateActivationEnding>;
  readonly revisionId: string;
  readonly scopeKey: string;
  readonly templateTypeId: string;
}

export interface TemplateInvalidationRecord {
  readonly invalidatedAt: DateTime.Utc;
  readonly invalidatedByPrincipalId: string;
  readonly reason: string;
  readonly revisionId: string;
}

/** Who acted, under which invocation and when: stamped on every write so who/what/when/why stays answerable. */
export interface TemplateWriteAttribution {
  readonly actionInvocationId: string;
  readonly at: DateTime.Utc;
  readonly principalId: string;
}

/**
 * The one owner-local port to template revisions (decision D-F), generated as this owner's Action service. Today it is
 * backed by Communications' own PostgreSQL tables; a code-versioned or managed-content form only has to provide this
 * interface again. Every program takes it as an argument: the Action's scoped transaction exists only per invocation.
 */
export interface TemplateRevisionPortContract {
  /** Activations of one Type whose period covers the instant (start inclusive, end exclusive). */
  readonly activationsAt: (
    templateTypeId: string,
    at: DateTime.Utc,
  ) => Effect.Effect<readonly TemplateActivationRecord[], TemplateStoreUnavailable>;
  readonly activationsOfRevision: (
    revisionId: string,
  ) => Effect.Effect<readonly TemplateActivationRecord[], TemplateStoreUnavailable>;
  /** Appends one activation period of a revision. The open-activation uniqueness is enforced by the store. */
  readonly appendActivation: (
    input: Omit<TemplateActivationRecord, 'activationId' | 'ending'> & {
      readonly actionInvocationId: string;
      /** The Legal Entity of a Legal Entity scoped Type; null for a tenant-wide Type. */
      readonly legalEntityId: string | null;
    },
  ) => Effect.Effect<TemplateActivationRecord, TemplateStoreUnavailable, Crypto.Crypto>;
  readonly appendInvalidation: (
    input: TemplateInvalidationRecord & { readonly actionInvocationId: string },
  ) => Effect.Effect<void, TemplateStoreUnavailable, Crypto.Crypto>;
  /** Adds the next revision of a Type: its number is assigned under the Type lock, so numbers never collide. */
  readonly appendRevision: (
    input: Omit<TemplateRevisionRecord, 'createdAt' | 'createdByPrincipalId' | 'revisionId' | 'revisionNumber'> &
      TemplateWriteAttribution,
  ) => Effect.Effect<TemplateRevisionRecord, TemplateStoreUnavailable, Crypto.Crypto>;
  readonly closeActivation: (
    activationId: string,
    ending: TemplateActivationEnding & { readonly actionInvocationId: string },
  ) => Effect.Effect<void, TemplateStoreUnavailable>;
  /** Creates the Type if its identity is new, then returns it locked, so concurrent writers of one Type serialize. */
  readonly ensureType: (
    input: Omit<TemplateTypeRecord, 'createdAt' | 'createdByPrincipalId' | 'templateTypeId'> & TemplateWriteAttribution,
  ) => Effect.Effect<TemplateTypeRecord, TemplateStoreUnavailable, Crypto.Crypto>;
  readonly findInvalidation: (
    revisionId: string,
  ) => Effect.Effect<Option.Option<TemplateInvalidationRecord>, TemplateStoreUnavailable>;
  readonly findType: (
    identity: TemplateIdentity,
  ) => Effect.Effect<Option.Option<TemplateTypeRecord>, TemplateStoreUnavailable>;
  readonly loadRevision: (
    revisionId: string,
  ) => Effect.Effect<Option.Option<TemplateRevisionRecord>, TemplateStoreUnavailable>;
  readonly loadType: (
    templateTypeId: string,
  ) => Effect.Effect<Option.Option<TemplateTypeRecord>, TemplateStoreUnavailable>;
  /** Loads a Type and locks it for the rest of the transaction. */
  readonly lockType: (
    templateTypeId: string,
  ) => Effect.Effect<Option.Option<TemplateTypeRecord>, TemplateStoreUnavailable>;
  /** The Type's open activations; more than one is a store defect and surfaces as such. */
  readonly openActivations: (
    templateTypeId: string,
  ) => Effect.Effect<readonly TemplateActivationRecord[], TemplateStoreUnavailable>;
  /** The authoritative operation time of the store, stable inside one transaction. */
  readonly operationAt: Effect.Effect<DateTime.Utc, TemplateStoreUnavailable>;
}

/** The Context tag of the port, for a later lane that composes its own Layer over a scoped transaction. */
export class TemplateRevisionPort extends Context.Service<TemplateRevisionPort, TemplateRevisionPortContract>()(
  '@app/communications/services/template-revision-port.service/TemplateRevisionPort',
) {}
