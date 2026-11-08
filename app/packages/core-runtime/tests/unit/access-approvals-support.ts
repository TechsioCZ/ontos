import { Effect, Option } from 'effect';

import {
  ApprovalAuthorityUnavailableError,
  ApprovalStorageConflictError,
  ApprovalStorageUnavailableError,
} from '../../src/access/approvals/errors.ts';
import type { WitnessFacts } from '../../src/access/approvals/execution.ts';
import type { FrozenCommandRecord } from '../../src/access/approvals/frozen-command.ts';
import type { GovernedCapability } from '../../src/access/approvals/policy.ts';
import type { BoundWitness } from '../../src/access/approvals/proposal.ts';
import type {
  ApprovalAuthorityInspector,
  ApprovalCapabilityCatalog,
  ApprovalClock,
  ApprovalDecisionEvidence,
  ApprovalIdentifiers,
  ApprovalProposalRecords,
  ApprovalScopeAdministration,
  ProposalScope,
  TenantScope,
} from '../../src/access/approvals/service.ts';
import type { AccessScopeId, CapabilityKey, PrincipalId, ProposalId, RoleRevisionId } from '../../src/access/ids.ts';
import type { AccessMode, Holder, Proposal } from '../../src/access/model.ts';

/*
 * Test-only adapters for the proposal and mandate suites (R2-L6). They live beside the tests, not in
 * `src/`: Core owns the real store, catalog and authority projection, and a scripted adapter that
 * shipped in `src/` would look like a production port.
 *
 * The authority adapter is a projection, not a rubber stamp: it reports the holder, scope and cell
 * that its own tables hold for each incarnation, so a witness naming somebody else's assignment is
 * reported with that somebody's holder and the verdict refuses it (R2-H1).
 */

const storageConflict = (reason: string): ApprovalStorageConflictError =>
  new ApprovalStorageConflictError({ code: 'approval_storage_conflict', reason });

export const approvalStorageUnavailable = (reason: string): ApprovalStorageUnavailableError =>
  new ApprovalStorageUnavailableError({ code: 'approval_storage_unavailable', reason });

const inScope = (proposal: Proposal, scope: TenantScope): boolean =>
  proposal.tenantId === scope.tenantId && (scope.scopeId === undefined || proposal.scopeId === scope.scopeId);

export interface InMemoryApprovalStore extends ApprovalProposalRecords {
  readonly all: () => readonly Proposal[];
  /** The evidence every recorded decision carried, in order; Core's real store logs the same. */
  readonly decisions: () => readonly ApprovalDecisionEvidence[];
  readonly frozen: () => readonly FrozenCommandRecord[];
  /** The reason of every recorded transition, in order; Core's real store persists the same field. */
  readonly reasons: () => readonly string[];
}

export const makeInMemoryApprovalStore = (initial: readonly Proposal[] = []): InMemoryApprovalStore => {
  const proposals = new Map<string, Proposal>(initial.map((proposal) => [proposal.id, proposal]));
  const frozenCommands = new Map<string, FrozenCommandRecord>();
  const reasons: string[] = [];
  const decisions: ApprovalDecisionEvidence[] = [];
  const remember = (proposal: Proposal) => {
    proposals.set(proposal.id, proposal);
  };
  /**
   * One transition of the double. It is deliberately as unbound as the real store's pre-R4 behaviour
   * except for the one rule the service routes on: only the workload's own method ends a proposal by
   * its deadline or its lost authority, so a test that mistakes the two paths finds it here too.
   */
  const transition = (input: {
    readonly evidence?: ApprovalDecisionEvidence;
    readonly expectedStatus: Proposal['status'];
    readonly proposal: Proposal;
    readonly reason?: string;
  }) => {
    const current = proposals.get(input.proposal.id);
    if (current === undefined || current.status !== input.expectedStatus) {
      return Effect.fail(storageConflict(`The stored proposal is not ${input.expectedStatus} any more`));
    }
    remember(input.proposal);
    if (input.reason !== undefined) {
      reasons.push(input.reason);
    }
    if (input.evidence !== undefined) {
      decisions.push(input.evidence);
    }
    return Effect.void;
  };
  return {
    all: () => [...proposals.values()],
    create: (proposal) =>
      proposals.has(proposal.id)
        ? Effect.fail(storageConflict('The proposal already exists'))
        : Effect.sync(() => remember(proposal)),
    createWithFrozenCommand: ({ frozen, proposal }) => {
      const stored = proposals.get(proposal.id);
      if (stored !== undefined) {
        // O90.4: one Action invocation owns one proposal. The same request answers the stored one; a
        // different command, scope or capability under the same invocation is a conflict.
        return stored.capabilityKey === proposal.capabilityKey &&
          stored.commandDigest === proposal.commandDigest &&
          stored.scopeId === proposal.scopeId &&
          stored.target === proposal.target
          ? Effect.succeed(stored)
          : Effect.fail(storageConflict('This Action invocation is already bound to a different proposal'));
      }
      return frozenCommands.has(proposal.id)
        ? Effect.fail(storageConflict('The frozen command already exists'))
        : Effect.sync(() => {
            remember(proposal);
            frozenCommands.set(proposal.id, frozen);
            return proposal;
          });
    },
    decisions: () => [...decisions],
    executeInTransaction: (input) => transition(input),
    frozen: () => [...frozenCommands.values()],
    listOpen: (input) =>
      Effect.sync(() =>
        [...proposals.values()].filter(
          (proposal) => inScope(proposal, input) && (proposal.status === 'pending' || proposal.status === 'approved'),
        ),
      ),
    load: (input) =>
      Effect.sync(() => {
        const proposal = proposals.get(input.proposalId);
        return proposal !== undefined && inScope(proposal, input) ? Option.some(proposal) : Option.none();
      }),
    reasons: () => [...reasons],
    recordEnd: (input) =>
      input.proposal.status === 'lapsed' || input.proposal.status === 'expired'
        ? transition(input)
        : Effect.fail(
            storageConflict(
              `A workload ends a proposal by its deadline or its lost authority, never as ${input.proposal.status}`,
            ),
          ),
    save: (input) => transition(input),
  };
};

export const makeInMemoryApprovalCatalog = (capabilities: readonly GovernedCapability[]): ApprovalCapabilityCatalog => {
  const byKey = new Map(capabilities.map((capability) => [capability.capabilityKey, capability]));
  return {
    lookup: (capabilityKey: CapabilityKey) => Effect.sync(() => Option.fromNullishOr(byKey.get(capabilityKey))),
  };
};

/** A mutable clock keeps every deadline asserted exactly, without reading the ambient clock. */
export interface MutableApprovalClock extends ApprovalClock {
  readonly set: (now: Date) => void;
}

export const makeMutableApprovalClock = (initial: Date): MutableApprovalClock => {
  let current = initial;
  return {
    now: Effect.sync(() => current),
    set: (now) => {
      current = now;
    },
  };
};

/** Hands out the identifiers a test arranged; exhaustion is a typed storage failure. */
export const makeScriptedApprovalIdentifiers = (ids: readonly ProposalId[]): ApprovalIdentifiers => {
  let index = 0;
  return {
    nextProposalId: Effect.suspend(() => {
      const next = ids[index];
      index += 1;
      return next === undefined
        ? Effect.fail(approvalStorageUnavailable('The scripted proposal identifiers are exhausted'))
        : Effect.succeed(next);
    }),
  };
};

/** One assignment incarnation the scripted projection knows: its holder, its revision and its scope. */
export interface ScriptedAssignment {
  readonly holderId: Holder;
  readonly roleRevisionId: RoleRevisionId;
  readonly scopeId: AccessScopeId;
}

/** One grant incarnation the scripted projection knows: its real cell, revision and scope. */
export interface ScriptedGrant {
  readonly cell: { readonly capabilityKey: CapabilityKey; readonly mode: AccessMode };
  readonly reachesTarget: boolean;
  readonly roleRevisionId: RoleRevisionId;
  readonly scopeId: AccessScopeId;
}

/**
 * A projection a test drives: bindings are added and revoked by incarnation id, exactly like the
 * real projection is written by the compiler. Nothing is derived from the witness being inspected.
 */
export interface ScriptedProjection extends ApprovalAuthorityInspector {
  /** Registers one live assignment and the grant cell it uses, in the mode the cell is held in. */
  readonly bind: (bound: BoundWitness, mode: AccessMode) => void;
  /** Puts one grant cell into another scope, as a foreign legal entity's grant would be. */
  readonly moveGrant: (bound: BoundWitness, scopeId: AccessScopeId) => void;
  /**
   * Takes one record out of a cell's reach, as reassigning the record does. The incarnation and the
   * cell stay live; only the record is no longer one the holder reaches (P5, N6).
   */
  readonly reassignRecord: (bound: BoundWitness) => void;
  /** Moves one assignment to another role revision, as a role edit would. */
  readonly rebind: (bound: BoundWitness, roleRevisionId: RoleRevisionId) => void;
  /** Reports one grant cell in another mode, as a propose-only grant used for a run would be. */
  readonly remodeGrant: (bound: BoundWitness, mode: AccessMode) => void;
  /** Ends one assignment incarnation; the grant cell keeps its own life. */
  readonly revoke: (bound: BoundWitness) => void;
}

export const makeScriptedProjection = (roleRevisionId: RoleRevisionId): ScriptedProjection => {
  const assignments = new Map<string, ScriptedAssignment>();
  const grants = new Map<string, ScriptedGrant>();
  const withAssignment = (bound: BoundWitness, change: (current: ScriptedAssignment) => ScriptedAssignment): void => {
    const current = assignments.get(bound.assignmentIncarnationId);
    if (current !== undefined) {
      assignments.set(bound.assignmentIncarnationId, change(current));
    }
  };
  const withGrant = (bound: BoundWitness, change: (current: ScriptedGrant) => ScriptedGrant): void => {
    const current = grants.get(bound.grantIncarnationId);
    if (current !== undefined) {
      grants.set(bound.grantIncarnationId, change(current));
    }
  };
  return {
    bind: (bound, mode) => {
      assignments.set(bound.assignmentIncarnationId, {
        holderId: bound.holderId,
        roleRevisionId,
        scopeId: bound.scopeId,
      });
      grants.set(bound.grantIncarnationId, {
        cell: { capabilityKey: bound.capabilityKey, mode },
        reachesTarget: true,
        roleRevisionId,
        scopeId: bound.scopeId,
      });
    },
    inspect: (input) =>
      Effect.succeed<readonly WitnessFacts[]>(
        input.witnesses.map((witness): WitnessFacts => {
          const assignment = assignments.get(witness.assignmentIncarnationId);
          const grant = grants.get(witness.grantIncarnationId);
          return {
            assignmentRoleRevisionId: assignment?.roleRevisionId ?? null,
            assignmentScopeId: assignment?.scopeId ?? null,
            assignmentState: assignment === undefined ? 'lost' : 'live',
            grantCell:
              grant === undefined
                ? null
                : { capabilityKey: grant.cell.capabilityKey, mode: grant.cell.mode, selector: { _tag: 'all' } },
            grantRoleRevisionId: grant?.roleRevisionId ?? null,
            grantScopeId: grant?.scopeId ?? null,
            grantState: grant === undefined ? 'lost' : 'live',
            holderId: assignment?.holderId ?? null,
            reachesTarget: grant === undefined ? null : grant.reachesTarget,
            witness,
          };
        }),
      ),
    moveGrant: (bound, scopeId) => withGrant(bound, (current) => ({ ...current, scopeId })),
    reassignRecord: (bound) => withGrant(bound, (current) => ({ ...current, reachesTarget: false })),
    rebind: (bound, next) => withAssignment(bound, (current) => ({ ...current, roleRevisionId: next })),
    remodeGrant: (bound, mode) => withGrant(bound, (current) => ({ ...current, cell: { ...current.cell, mode } })),
    revoke: (bound) => {
      assignments.delete(bound.assignmentIncarnationId);
    },
  };
};

/**
 * The scope's own administration fact (O61). A test arranges who administers which scope, so an
 * administrator is a resolved fact rather than a hard-coded `true`.
 */
export const makeScriptedScopeAdministration = (
  administrators: readonly { readonly principalId: PrincipalId; readonly scopeId: AccessScopeId }[] = [],
): ApprovalScopeAdministration => ({
  isAdministrator: (input: ProposalScope & { readonly principalId: PrincipalId }) =>
    Effect.succeed(
      administrators.some((entry) => entry.principalId === input.principalId && entry.scopeId === input.scopeId),
    ),
});

/** Simulates a projection that cannot answer: a retryable failure, never a denial. */
export const makeUnavailableAuthorityInspector = (): ApprovalAuthorityInspector => ({
  inspect: () =>
    Effect.fail(
      new ApprovalAuthorityUnavailableError({
        code: 'approval_authority_unavailable',
        reason: 'The authority projection is unavailable',
      }),
    ),
});
