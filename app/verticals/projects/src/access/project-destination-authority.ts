import {
  AccessKeySchema,
  OwnerAuthorizationOverlay,
  bindLiveAccessGate,
  failClosedOwnerAuthorizationOverlay,
} from '@app/core-runtime';
import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  ScopedTransactionExecutor,
  BoundAccessGate,
} from '@app/core-runtime';
import { asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { ModuleKeySchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import type {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  DecisionCheck,
  LegalEntityCandidates,
} from '@app/core-runtime/access/enforcement';
import { projects } from '../db/schema.ts';
import { ProjectPersistenceUnavailable } from '../../shared/domain/project-persistence-unavailable.ts';
import { projectDescendantIds } from '../services/project-persistence.service.ts';
import { PROJECT_DESTINATION_PARENT_FACT } from './project-destination-facts.ts';

const moduleKey = 'projects.core';
const createCapability = 'projects.core.project.create';
const moveCapability = 'projects.core.project.move';
const moveAccessKey = AccessKeySchema.make(moveCapability);

type HierarchyRow = Readonly<{ parentProjectId: null | string; projectId: string }>;

const targetSchema = Schema.Struct({ moduleKey: ModuleKeySchema, recordKey: RecordKeySchema });
const targetOf = (recordKey: string) => Schema.decodeOption(targetSchema)({ moduleKey, recordKey });

const ownerDecisionOf = (
  outcome: 'ALLOWED' | 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE',
): OwnerAuthorizationDecision => {
  if (outcome === 'ALLOWED') {
    return 'allowed';
  }
  return outcome === 'UNAVAILABLE' ? 'unavailable' : 'denied';
};

/** The only permission question for a hierarchy edge uses the destination record's write capability. */
const decideRecord = (gate: BoundAccessGate, input: OwnerAuthorizationInput, recordKey: string) => {
  const target = targetOf(recordKey);
  if (Option.isNone(target)) {
    return Effect.succeed<OwnerAuthorizationDecision>('denied');
  }
  return gate
    .decide({
      carrier: {
        accessDeclaration: {
          key: moveAccessKey,
          kind: 'action',
          modes: ['run', 'propose', 'approve'],
          placement: { group: 'projects', level: 'manage' },
          risk: 'sensitive',
          selectors: ['all'],
        },
      },
      legalEntityScope: 'optional',
      now: DateTime.toDate(input.operationAt),
      scope: input.scope,
      target: target.value,
    })
    .pipe(Effect.map((decision) => ownerDecisionOf(decision.outcome)));
};

/** The first record whose decision is not `allowed` decides the move; later records are never asked. */
const allowedVerdict = (): OwnerAuthorizationDecision => 'allowed';
const firstBlockingDecision = (gate: BoundAccessGate, input: OwnerAuthorizationInput, recordKeys: readonly string[]) =>
  Effect.reduce(recordKeys, allowedVerdict, (verdict, recordKey) =>
    verdict === 'allowed' ? decideRecord(gate, input, recordKey) : Effect.succeed(verdict),
  );

const lockTenantHierarchy = (transaction: ScopedTransactionExecutor, tenantId: string) =>
  transaction
    .select()
    .from(projects)
    .where(eq(projects.tenantId, tenantId))
    .orderBy(asc(projects.projectId))
    .for('update')
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProjectPersistenceUnavailable({
            cause,
            code: 'project_persistence_unavailable',
            reason: 'Project persistence is temporarily unavailable',
          }),
      ),
    );

/**
 * Decides a hierarchy edge. `loadHierarchy` runs only when the edge needs the tenant hierarchy, so a
 * root create never locks it. Core calls the overlay inside the business transaction, so the loader
 * locks the whole tenant hierarchy before deciding either end or the descendants; the mutation uses
 * the same locked rows.
 */
export const decideProjectDestination = Effect.fn('ProjectDestinationAuthority.decide')(
  function* checkHierarchyAuthority(
    gate: BoundAccessGate,
    input: OwnerAuthorizationInput,
    loadHierarchy: () => Effect.Effect<readonly HierarchyRow[], ProjectPersistenceUnavailable>,
  ) {
    const parentId = input.ownerFacts?.[PROJECT_DESTINATION_PARENT_FACT];
    const moving = input.capabilityKey === moveCapability;
    if (!moving && parentId === undefined) {
      return 'allowed' as const;
    }
    const hierarchy = yield* loadHierarchy();
    if (parentId !== undefined) {
      if (Option.isNone(targetOf(parentId)) || !hierarchy.some((row) => row.projectId === parentId)) {
        return 'denied' as const;
      }
      const decision = yield* decideRecord(gate, input, parentId);
      if (decision !== 'allowed') {
        return decision;
      }
    }
    if (!moving) {
      return 'allowed' as const;
    }
    const sourceId = input.target?.recordKey;
    if (
      sourceId === undefined ||
      input.target?.moduleKey !== moduleKey ||
      !hierarchy.some((row) => row.projectId === sourceId)
    ) {
      return 'denied' as const;
    }
    // Root has no parent to ask. The source and every affected descendant remain mandatory.
    return yield* firstBlockingDecision(gate, input, projectDescendantIds(hierarchy, sourceId));
  },
);

export const makeProjectDestinationAuthority = (gate: BoundAccessGate): OwnerAuthorizationOverlayService => ({
  authorize: (transaction: ScopedTransactionExecutor, input: OwnerAuthorizationInput) => {
    if (input.owningModuleKey !== moduleKey || input.operation !== 'action') {
      return failClosedOwnerAuthorizationOverlay.authorize(transaction, input);
    }
    if (input.capabilityKey !== createCapability && input.capabilityKey !== moveCapability) {
      return failClosedOwnerAuthorizationOverlay.authorize(transaction, input);
    }
    return decideProjectDestination(gate, input, () => lockTenantHierarchy(transaction, input.scope.tenantId)).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.annotateLogs(Effect.logWarning('The project destination authority is unavailable'), { error }).pipe(
            Effect.as('unavailable' as const),
          ),
        onSuccess: Effect.succeed,
      }),
    );
  },
});

export const projectDestinationAuthorityLive: Layer.Layer<
  OwnerAuthorizationOverlay,
  never,
  | AccessDecisionGate
  | AccessDecisionLog
  | AccessIntent
  | AccessPrincipalKindSource
  | DecisionCheck
  | LegalEntityCandidates
> = Layer.effect(OwnerAuthorizationOverlay, bindLiveAccessGate.pipe(Effect.map(makeProjectDestinationAuthority)));
