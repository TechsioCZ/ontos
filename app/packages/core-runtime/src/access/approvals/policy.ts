import { DateTime, Duration } from 'effect';

import type { CapabilityKey } from '../ids.ts';
import type { AccessKind, AccessMode, AccessRisk, RecordSelector } from '../model.ts';

/**
 * The approval a person gives outlives their decision by 24 hours, or one hour for a critical
 * command, and it is single use (P10).
 */
const APPROVAL_LIFETIME = {
  critical: Duration.hours(1),
  routine: Duration.hours(24),
  sensitive: Duration.hours(24),
} as const satisfies Record<AccessRisk, Duration.Duration>;

/**
 * How long a proposal may wait for a person at all (R2-L7). P10 bounds approval-to-execution, not
 * the queue in "Ke schválení", so an unapproved proposal gets its own, longer deadline. A week is
 * long enough for a holiday hand-over and short enough that the queue never accumulates stale
 * requests; the risk tier does not change it, because nothing executes on it.
 */
const PROPOSAL_LIFETIME = Duration.days(7);

export const approvalLifetimeMillis = (risk: AccessRisk): number => Duration.toMillis(APPROVAL_LIFETIME[risk]);

/** The proposal deadline, measured from creation; independent of the risk tier (R2-L7). */
export const proposalLifetimeMillis = (): number => Duration.toMillis(PROPOSAL_LIFETIME);

/** The catalog facts a proposal is bound to. They come from the published snapshot, never a caller. */
export interface GovernedCapability {
  readonly capabilityKey: CapabilityKey;
  /** A short-lived proof cannot wait for a person, so it is never proposed or approved (O22). */
  readonly ephemeral?: boolean;
  readonly kind: AccessKind;
  readonly modes: readonly AccessMode[];
  /**
   * The read that governs the record a record-scoped command changes (D30). Core takes it from the
   * published entry, never from the command: a caller that omits or renames it changes nothing (O64).
   */
  readonly parentRecordReadCapabilityKey?: CapabilityKey;
  /** Catalog override for an entrypoint whose verb does not already name a power change (P6). */
  readonly raisesAuthority?: boolean;
  readonly risk: AccessRisk;
  readonly selectors: readonly RecordSelector[];
}

/** Verbs that hand out, remove or impersonate authority; they always need a second person (P6). */
const AUTHORITY_VERBS: ReadonlySet<string> = new Set(['administer', 'delegate', 'grant', 'impersonate', 'revoke']);

const keyWords = (key: string): readonly string[] => key.split(/[^a-z0-9]+/u).filter((word) => word.length > 0);

/** A command raises authority when it is administrative or its key names a power change (P6). */
export const raisesAuthority = (capability: GovernedCapability): boolean =>
  capability.raisesAuthority === true ||
  capability.kind === 'admin' ||
  keyWords(capability.capabilityKey).some((word) => AUTHORITY_VERBS.has(word));

/** A declaration is proposable when it supports the propose mode and is not ephemeral (O22). */
export const isProposable = (capability: GovernedCapability): boolean =>
  capability.ephemeral !== true && capability.modes.includes('propose');

/** Agents never administer, so an administrative command is never theirs to propose (D2, P4). */
export const isProposableByAgent = (capability: GovernedCapability): boolean =>
  isProposable(capability) && capability.kind !== 'admin';

/** Only a declaration that supports the approve mode can be confirmed by somebody else (O14). */
export const isApprovable = (capability: GovernedCapability): boolean =>
  capability.ephemeral !== true && capability.modes.includes('approve');

/** Identity-bound entrypoints run as the original actor; nobody approves them for another (O14). */
export const isIdentityBound = (capability: GovernedCapability): boolean =>
  capability.ephemeral !== true && capability.modes.includes('run') && !capability.modes.includes('approve');

/** Adds a bounded lifetime to a trusted instant without reading the ambient clock. */
export const addMilliseconds = (from: Date, milliseconds: number): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(from).pipe(DateTime.add({ milliseconds })));

/** The earlier of two deadlines: an approval never extends the proposal it approves. */
export const earliest = (left: Date, right: Date): Date => (left <= right ? left : right);
