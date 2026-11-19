import { Context } from 'effect';
import type { Crypto, DateTime, Effect, Option } from 'effect';
import type { TemplateIdentity } from '../../shared/template-revision.ts';
import type { TemplateStoreUnavailable as TemplateStoreUnavailableClass } from '../../shared/template-revision-errors.ts';

type TemplateStoreUnavailable = InstanceType<typeof TemplateStoreUnavailableClass>;

/** A Template Type is identity only: its declared placeholders live on each of its revisions. */
export interface TemplateTypeRecord {
  readonly createdAt: DateTime.Utc;
  readonly createdByPrincipalId: string;
  readonly identity: TemplateIdentity;
  readonly templateTypeId: string;
}

export interface TemplateRevisionRecord {
  readonly body: string;
  readonly contentDigest: string;
  readonly createdAt: DateTime.Utc;
  readonly createdByPrincipalId: string;
  /** Placeholder names this revision declares as allowed but not required. */
  readonly optionalPlaceholders: readonly string[];
  readonly placeholdersUsed: readonly string[];
  readonly reason: string;
  /** Placeholder names this revision declares as required: its text must use every one of them. */
  readonly requiredPlaceholders: readonly string[];
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
interface TemplateWriteAttribution {
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
  /**
   * The database wall clock, read at the moment of the call. It is business time only after the Type lock is held: a
   * transaction-start time would predate the activations a concurrent writer committed while this one waited.
   */
  readonly clockNow: Effect.Effect<DateTime.Utc, TemplateStoreUnavailable>;
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
  /** The latest instant any activation of the Type started or ended; none when it was never activated. */
  readonly latestActivityAt: (
    templateTypeId: string,
  ) => Effect.Effect<Option.Option<DateTime.Utc>, TemplateStoreUnavailable>;
  readonly loadRevision: (
    revisionId: string,
  ) => Effect.Effect<Option.Option<TemplateRevisionRecord>, TemplateStoreUnavailable>;
  readonly loadType: (
    templateTypeId: string,
  ) => Effect.Effect<Option.Option<TemplateTypeRecord>, TemplateStoreUnavailable>;
  /** Loads a Type and locks it exclusively for the rest of the transaction: every writer of the Type serializes. */
  readonly lockType: (
    templateTypeId: string,
  ) => Effect.Effect<Option.Option<TemplateTypeRecord>, TemplateStoreUnavailable>;
  /** Locks a Type for sharing: resolvers run together but never while a writer holds or awaits its exclusive lock. */
  readonly lockTypeShared: (templateTypeId: string) => Effect.Effect<void, TemplateStoreUnavailable>;
  /** The Type's open activations; more than one is a store defect and surfaces as such. */
  readonly openActivations: (
    templateTypeId: string,
  ) => Effect.Effect<readonly TemplateActivationRecord[], TemplateStoreUnavailable>;
}

/**
 * What resolving and verifying a pin READS, and nothing it writes. The Action reads it from its own transaction; the
 * pre-handoff worker has no transaction and reads one consistent snapshot through a scoped routine, so both run the same
 * domain code over the same narrow surface.
 */
export type TemplateReadPortContract = Pick<
  TemplateRevisionPortContract,
  | 'activationsAt'
  | 'clockNow'
  | 'findInvalidation'
  | 'findType'
  | 'latestActivityAt'
  | 'loadRevision'
  | 'loadType'
  | 'lockTypeShared'
>;

/** The Context tag of the port, for a later lane that composes its own Layer over a scoped transaction. */
export class TemplateRevisionPort extends Context.Service<TemplateRevisionPort, TemplateRevisionPortContract>()(
  '@app/communications/services/template-revision-port.service/TemplateRevisionPort',
) {}
