import type { ActiveApplicationCompositionSnapshot, OperationalScope } from '@app/core-runtime';
import {
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  DecisionCheck,
  SubjectAccessInspectionLive,
  SubjectInspectionIdentitySource,
} from '@app/core-runtime/access/enforcement';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
} from '@app/core-runtime/access/ids';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { Effect, Layer, Option } from 'effect';

interface InspectionFixtureSubject {
  readonly kind?: 'agent' | 'human';
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

interface InspectionFixtureCapability {
  readonly key: string;
  readonly modes: readonly ('propose' | 'run')[];
  readonly selector?: 'all' | 'assigned';
}

/** Actual Core inspection and decision engine; only identity/intent/graph I/O is scripted. */
export const subjectInspectionFixture = (input: {
  readonly capabilities?: readonly InspectionFixtureCapability[];
  readonly onScopeRead?: (principalId: string) => Effect.Effect<void>;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
  readonly subjects: readonly InspectionFixtureSubject[];
}) => {
  const requesterScopes: OperationalScope[] = [];
  const subjectOf = (principalId: string) => input.subjects.find((subject) => subject.principalId === principalId);
  const companyScopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000018');
  const tenantScopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000019');
  const intent: (typeof AccessIntent)['Service'] = {
    authorityFor: (requesterScope) => {
      requesterScopes.push(requesterScope);
      return {
        readCells: (query) => {
          const capability = input.capabilities?.find((entry) => entry.key === query.capabilityKey);
          return Effect.succeed(
            capability === undefined || !capability.modes.some((mode) => mode === query.mode)
              ? []
              : [
                  {
                    assignedAt: new Date('2026-01-01T00:00:00Z'),
                    assignedBy: PrincipalIdSchema.make(requesterScope.principalId),
                    assignmentIncarnationId: AssignmentIncarnationIdSchema.make('00000000-0000-4000-8000-000000000021'),
                    capabilityKey: query.capabilityKey,
                    grantIncarnationId: GrantIncarnationIdSchema.make('00000000-0000-4000-8000-000000000022'),
                    holder: query.holder,
                    mode: query.mode,
                    roleId: RoleIdSchema.make('00000000-0000-4000-8000-000000000023'),
                    roleRevisionId: RoleRevisionIdSchema.make('00000000-0000-4000-8000-000000000024'),
                    selector: { _tag: capability.selector ?? 'all' },
                  },
                ],
          );
        },
        readConfigureBases: () => Effect.succeed([]),
        readConnection: () => Effect.succeed(Option.none()),
        readScope: (query) => {
          const principal = query.holders.find((holder) => holder._tag === 'Principal');
          const inScope =
            query.tenantId === requesterScope.tenantId &&
            query.holders.every((holder) => {
              const id = holder._tag === 'Principal' ? holder.principalId : holder.agentId;
              const subject = subjectOf(id);
              return (
                subject !== undefined &&
                subject.tenantId === query.tenantId &&
                (query.legalEntityId === undefined || subject.legalEntityId === query.legalEntityId)
              );
            });
          const holderDeadlines = query.holders.map((holder) => ({ deadlines: [], holder }));
          return Effect.gen(function* fixtureInspectionScope() {
            if (principal !== undefined && principal._tag === 'Principal' && input.onScopeRead !== undefined) {
              yield* input.onScopeRead(principal.principalId);
            }
            if (!inScope) {
              return Option.none();
            }
            return Option.some({
              deadlines: [],
              holderDeadlines,
              scope:
                query.legalEntityId === undefined
                  ? { _tag: 'TenantContext' as const, tenantId: query.tenantId }
                  : { _tag: 'LegalEntity' as const, legalEntityId: query.legalEntityId, tenantId: query.tenantId },
              scopeId: query.legalEntityId === undefined ? tenantScopeId : companyScopeId,
              tenantId: query.tenantId,
            });
          });
        },
        readTeamIds: () => Effect.succeed([]),
      };
    },
  };
  const layer = SubjectAccessInspectionLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(input.snapshot) }),
        Layer.succeed(AccessIntent, intent),
        Layer.succeed(AccessPrincipalKindSource, {
          readKind: ({ principalId, scope, tenantId }) => {
            requesterScopes.push(scope);
            const subject = subjectOf(principalId);
            return Effect.succeed(
              subject === undefined || subject.tenantId !== tenantId
                ? Option.none()
                : Option.some(subject.kind ?? 'human'),
            );
          },
        }),
        Layer.succeed(SubjectInspectionIdentitySource, {
          read: ({ legalEntityId, principalId, requesterScope }) => {
            requesterScopes.push(requesterScope);
            const subject = subjectOf(principalId);
            return Effect.succeed(
              subject === undefined ||
                subject.tenantId !== requesterScope.tenantId ||
                (legalEntityId !== undefined && subject.legalEntityId !== legalEntityId)
                ? Option.none()
                : Option.some({
                    companyStatus: 'active',
                    membership: { affiliation: subject.kind === 'agent' ? null : 'employee', status: 'active' },
                    principalStatus: 'active',
                    tenantStatus: 'active',
                  }),
            );
          },
        }),
        Layer.succeed(DecisionCheck, {
          checkBulk: (checks) => Effect.succeed(checks.map(() => ({ permissionship: 'has' as const }))),
        }),
        Layer.succeed(AccessDecisionLog, {
          record: ({ scope }) =>
            Effect.sync(() => {
              requesterScopes.push(scope);
            }),
        }),
      ),
    ),
  );
  return { layer, requesterScopes };
};
