import type { ActiveApplicationCompositionSnapshot, OperationalScope } from '@app/core-runtime';
import { OntosModuleIdSchema, TenantModuleStateService } from '@app/core-runtime';
import {
  AccessDecisionLogBatch,
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
import { Effect, Layer, Option, Predicate } from 'effect';

import type { AccessDecisionUnavailable } from '../../../../../packages/core-runtime/src/access/decision/errors.ts';
import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import { makeInstalledModuleCatalogLoader } from '../../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';

/**
 * One read-page carrier per module, each under its own declaration key, in the order the modules are given. The
 * snapshot is what the inspection reads; the installed catalog is what the caller loads.
 */
export const pageCarrierCatalog = (moduleIds: readonly string[]) =>
  Effect.gen(function* pageCarrierCatalogEffect() {
    const snapshot = yield* makeCompositionSnapshot(
      moduleIds.map((id) => {
        const contract = makeModuleContractFixture({ appId: id.replaceAll('.', '-'), moduleId: id });
        return {
          ...contract,
          manifest: {
            ...contract.manifest,
            publicSurface: {
              ...contract.manifest.publicSurface,
              actions: [],
              components: [{ expose: './PageHome', key: `${id}.page-home`, mfBoundaryId: id.replaceAll('.', '') }],
              shellContributions: {
                ...contract.manifest.publicSurface.shellContributions,
                pages: [
                  {
                    accessDeclaration: {
                      key: `${id}.page.open`,
                      kind: 'read',
                      modes: ['run'],
                      placement: { group: 'pages', level: 'basic' },
                      risk: 'routine',
                      selectors: [],
                    },
                    componentKey: `${id}.page-home`,
                    contributionKey: `${id}.page.home`,
                    entrypoint: {
                      access: 'read',
                      authorization: { kind: 'protected' },
                      entrypointKey: `${id}.page.home`,
                      moduleKey: id,
                      role: 'page',
                      scope: 'tenant',
                    },
                    expose: './PageHome',
                    routePath: `/${id.replaceAll('.', '-')}`,
                  },
                ],
              },
            },
          },
        };
      }),
    );
    const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    return { installed, snapshot };
  });

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

type CellQuery = Parameters<ReturnType<(typeof AccessIntent)['Service']['authorityFor']>['readCells']>[0];

const capabilityNamed = (capabilities: readonly InspectionFixtureCapability[] | undefined, key: string) =>
  capabilities?.find((entry) => entry.key === key);

/** The one cell a declared capability answers, for the queried mode; none when it is not declared for that mode. */
const cellsOf = (capability: InspectionFixtureCapability | undefined, query: CellQuery, assignedBy: string) =>
  capability === undefined || !capability.modes.some((mode) => mode === query.mode)
    ? []
    : [
        {
          assignedAt: new Date('2026-01-01T00:00:00Z'),
          assignedBy: PrincipalIdSchema.make(assignedBy),
          assignmentIncarnationId: AssignmentIncarnationIdSchema.make('00000000-0000-4000-8000-000000000021'),
          capabilityKey: query.capabilityKey,
          grantIncarnationId: GrantIncarnationIdSchema.make('00000000-0000-4000-8000-000000000022'),
          holder: query.holder,
          mode: query.mode,
          roleId: RoleIdSchema.make('00000000-0000-4000-8000-000000000023'),
          roleRevisionId: RoleRevisionIdSchema.make('00000000-0000-4000-8000-000000000024'),
          selector: { _tag: capability.selector ?? 'all' },
        },
      ];

/** Actual Core inspection and decision engine; only identity/intent/graph I/O is scripted. */
export const subjectInspectionFixture = (input: {
  readonly capabilities?: readonly InspectionFixtureCapability[];
  /** The modules the tenant has installed (active); by default every module of the composition. */
  readonly installedModules?: readonly string[];
  /** Runs before each capability read: a test can hold it (to observe overlap) or fail it (an unreadable carrier). */
  readonly onCapabilityRead?: (capabilityKey: string) => Effect.Effect<void, AccessDecisionUnavailable>;
  readonly onScopeRead?: (principalId: string) => Effect.Effect<void>;
  /** Tenant owners: Core answers their configure authority with the `Owner` basis, as for a stage tenant's owner. */
  readonly owners?: readonly string[];
  readonly snapshot: ActiveApplicationCompositionSnapshot;
  readonly subjects: readonly InspectionFixtureSubject[];
}) => {
  const requesterScopes: OperationalScope[] = [];
  /** Every scripted port call, so a test can bound the round trips one inspection makes. */
  const reads = { cells: 0, engine: 0, evidenceRows: 0, evidenceWrites: 0, facts: 0, kind: 0, scope: 0 };
  const subjectOf = (principalId: string) => input.subjects.find((subject) => subject.principalId === principalId);
  const companyScopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000018');
  const tenantScopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000019');
  const intent: (typeof AccessIntent)['Service'] = {
    authorityFor: (requesterScope) => {
      requesterScopes.push(requesterScope);
      return {
        readCells: (query) =>
          Effect.sync(() => {
            reads.cells += 1;
          }).pipe(
            Effect.andThen(input.onCapabilityRead?.(query.capabilityKey) ?? Effect.void),
            Effect.andThen(() =>
              Effect.succeed(
                cellsOf(capabilityNamed(input.capabilities, query.capabilityKey), query, requesterScope.principalId),
              ),
            ),
          ),
        readConfigureBases: ({ actor }) =>
          Effect.succeed(input.owners?.includes(actor) === true ? [{ _tag: 'Owner' as const }] : []),
        readConnection: () => Effect.succeed(Option.none()),
        readScope: (query) => {
          const principal = query.holders.find((holder) => Predicate.isTagged(holder, 'Principal'));
          const inScope =
            query.tenantId === requesterScope.tenantId &&
            query.holders.every((holder) => {
              const id = Predicate.isTagged(holder, 'Principal') ? holder.principalId : holder.agentId;
              const subject = subjectOf(id);
              return (
                subject !== undefined &&
                subject.tenantId === query.tenantId &&
                (query.legalEntityId === undefined || subject.legalEntityId === query.legalEntityId)
              );
            });
          const holderDeadlines = query.holders.map((holder) => ({ deadlines: [], holder }));
          return Effect.gen(function* fixtureInspectionScope() {
            reads.scope += 1;
            if (
              principal !== undefined &&
              Predicate.isTagged(principal, 'Principal') &&
              input.onScopeRead !== undefined
            ) {
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
  const installed = new Set(
    input.installedModules ?? input.snapshot.composition.modules.map(({ moduleId }) => moduleId),
  );
  /** Every tenant module state read: the tenant and the module keys asked about. */
  const stateReads: { readonly moduleKeys: readonly string[]; readonly tenantId: string }[] = [];
  const moduleStates = Layer.mock(TenantModuleStateService, {
    getTenantModuleStates: (tenantId, moduleKeys) =>
      Effect.sync(() => {
        stateReads.push({ moduleKeys: [...moduleKeys], tenantId });
        return moduleKeys
          .filter((moduleKey) => installed.has(moduleKey))
          .map((moduleKey) => ({ moduleKey: OntosModuleIdSchema.make(moduleKey), state: 'active' as const }));
      }),
  });
  const inspectionLayer = SubjectAccessInspectionLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(input.snapshot) }),
        Layer.succeed(AccessIntent, intent),
        Layer.succeed(AccessPrincipalKindSource, {
          readKind: ({ principalId, scope, tenantId }) => {
            reads.kind += 1;
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
            reads.facts += 1;
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
          checkBulk: (checks) =>
            Effect.sync(() => {
              reads.engine += 1;
              return checks.map(() => ({ permissionship: 'has' as const }));
            }),
        }),
        Layer.succeed(AccessDecisionLogBatch, {
          recordAll: (entries) =>
            Effect.sync(() => {
              reads.evidenceWrites += 1;
              reads.evidenceRows += entries.length;
              for (const { scope } of entries) {
                requesterScopes.push(scope);
              }
            }),
        }),
      ),
    ),
  );
  return { layer: Layer.merge(inspectionLayer, moduleStates), reads, requesterScopes, stateReads };
};
