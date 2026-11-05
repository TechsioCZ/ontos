import { Clock, Context, DateTime, Effect, Layer, Match, Result } from 'effect';

import type { AccessCatalogModule } from '../../authorization/access-declaration.ts';
import { CoreDatabase } from '../../db/client.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import { AccessChangesStore } from '../changes/persistence/store.ts';
import { findRole } from '../changes/role-edits.ts';
import { AccessCatalogSnapshotWriter } from '../intent/catalog-snapshot-writer.ts';
import { AccessMembershipIdSchema, AccessMembershipStore } from '../intent/memberships.ts';
import type { AccessMembership, MembershipKind } from '../intent/memberships.ts';
import type { AccessIntentDatabase } from '../intent/persistence.ts';
import { AccessProjectionWriter } from '../intent/projection-writer.ts';
import type { TenantProjectionWrite } from '../intent/projection-writer.ts';
import { TenantIntentLoader } from '../intent/tenant-intent-loader.ts';
import { holderKey } from '../model.ts';
import type { Cell, Role, RoleRevision } from '../model.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, RoleIdSchema, RoleRevisionIdSchema, TenantIdSchema } from '../ids.ts';
import type {
  AccessScopeId,
  CatalogSnapshotId,
  LegalEntityId,
  PrincipalId,
  RoleId,
  RoleRevisionId,
  TenantId,
} from '../ids.ts';
import { bootstrapRefusal, bootstrapSourceRefusal } from './errors.ts';
import type { AccessBootstrapError } from './errors.ts';
import { FULL_ACCESS_ROLE_NAME, FULL_ACCESS_ROLE_TEMPLATE_KEY, compileFullAccessRole } from './full-access-role.ts';
import { bootstrapScopesOf, tenantContextScopeId, writeBootstrapScopes, writeOwnerAssignments } from './persistence.ts';
import type { BootstrapScope } from './persistence.ts';

/*
 * A new tenant's access (O67-Q6, P2). Nothing is usable without an assignment, so a tenant created without
 * this bootstrap has no owner, no role and no capability; this is the one place a tenant's first authority
 * comes from:
 *
 * 1. its scopes (the tenant context and one per company), each with the fence a projection needs (D15);
 * 2. its owner's memberships — `owner` in the tenant context plus `member` there and in every company,
 *    because management authority still requires membership before it administers anything (O28, O65);
 * 3. the release catalog, published from the installed modules' declarations while nothing is released
 *    yet (O67-Q7);
 * 4. the role "Plný přístup": every capability of that release, with every mode and the widest selector
 *    each declares, assigned to the owner in every scope with the grant incarnations a decision reads;
 * 5. one reconcile of the tenant through the single Core writer.
 *
 * Every step is idempotent, and none of them revives what an administrator ended: a re-run finds the
 * scopes, the memberships (whatever their status), the role with its pinned revision and the same
 * assignment incarnations, writes only what is missing, and reconciles an unchanged intent to nothing.
 */

export interface BootstrapTenantAccessRequest {
  /** The companies the tenant starts with; each one gets its own scope, membership and assignment. */
  readonly legalEntityIds: readonly LegalEntityId[];
  /** Every module the running composition declares; only the tenant's installations are released. */
  readonly modules: readonly AccessCatalogModule[];
  /** The trusted request scope: its tenant is created and its principal becomes the owner (O66). */
  readonly scope: OperationalScope;
}

export interface BootstrapTenantAccessResult {
  readonly catalogSnapshotId: CatalogSnapshotId;
  /** The cells the owner holds: every capability of the release, one per declared mode and slot. */
  readonly cells: readonly Cell[];
  readonly legalEntityIds: readonly LegalEntityId[];
  readonly ownerPrincipalId: PrincipalId;
  readonly projection: TenantProjectionWrite;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
  readonly scopes: readonly BootstrapScope[];
  readonly tenantId: TenantId;
}

export interface TenantAccessBootstrapService {
  readonly bootstrapTenantAccess: (
    request: BootstrapTenantAccessRequest,
  ) => Effect.Effect<BootstrapTenantAccessResult, AccessBootstrapError>;
}

const now = Effect.fn('TenantAccessBootstrap.now')(function* nowEffect() {
  const millis = yield* Clock.currentTimeMillis;
  return DateTime.toDateUtc(DateTime.makeUnsafe(millis));
});

const intentRefused = (cause: { readonly code: string; readonly reason: string }) =>
  bootstrapSourceRefusal('access_bootstrap_intent_refused', cause);

/** One membership a tenant starts with: the owner's, in one scope, in one kind. */
interface MembershipRequest {
  readonly at: Date;
  readonly kind: AccessMembership['kind'];
  readonly principalId: PrincipalId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

const membershipOf = (request: MembershipRequest): AccessMembership => ({
  createdAt: request.at,
  holder: { _tag: 'Principal', principalId: request.principalId },
  id: AccessMembershipIdSchema.make(
    // Deterministic, so a repeated bootstrap resumes the membership it wrote instead of adding another (D27).
    stableUuid(
      ['ontos.access.bootstrap.membership', request.tenantId, request.scopeId, request.kind, request.principalId].join(
        ':',
      ),
    ),
  ),
  kind: request.kind,
  recordedBy: request.principalId,
  scopeId: request.scopeId,
  status: 'active',
  tenantId: request.tenantId,
  validFrom: request.at,
});

/** The key a membership is unique by: one holder, in one scope, in one kind. */
const membershipKeyOf = (input: {
  readonly holderKey: string;
  readonly kind: string;
  readonly scopeId: string;
}): string => [input.scopeId, input.kind, input.holderKey].join(':');

/**
 * The memberships a tenant starts with: the owner's `owner` and `member` rows in the tenant context, and a
 * `member` row in every company. A row that already exists is never written again, and a membership that
 * was suspended or revoked stays that way — a bootstrap creates a tenant's first authority, it does not
 * reopen what an administrator ended (D27).
 */
const membershipsToWrite = (
  existing: readonly AccessMembership[],
  wanted: readonly MembershipRequest[],
): readonly AccessMembership[] => {
  const present = new Set<string>(
    existing.map((membership) =>
      membershipKeyOf({ holderKey: holderKey(membership.holder), kind: membership.kind, scopeId: membership.scopeId }),
    ),
  );
  return wanted.flatMap((request) => {
    // The holder key is the model's own (`principal <id>`), so a person is matched the way Core names them.
    const holder = holderKey({ _tag: 'Principal', principalId: request.principalId });
    return present.has(membershipKeyOf({ holderKey: holder, kind: request.kind, scopeId: request.scopeId }))
      ? []
      : [membershipOf(request)];
  });
};

/** The two membership kinds a tenant context carries: it is owned and it is joined. */
const TENANT_CONTEXT_MEMBERSHIP_KINDS: readonly MembershipKind[] = ['owner', 'member'];

/** The memberships a new tenant's owner holds: ownership plus membership, in its context and companies. */
const ownerMembershipsOf = (input: {
  readonly at: Date;
  readonly principalId: PrincipalId;
  readonly scopes: readonly BootstrapScope[];
  readonly tenantId: TenantId;
}): readonly MembershipRequest[] => {
  const tenantContextScope = tenantContextScopeId(input.tenantId);
  // The two kinds a tenant context carries: ownership and the membership administration rests on (O28).
  const tenantContext = TENANT_CONTEXT_MEMBERSHIP_KINDS.map((kind): MembershipRequest => ({
    at: input.at,
    kind,
    principalId: input.principalId,
    scopeId: tenantContextScope,
    tenantId: input.tenantId,
  }));
  // A company starts with membership only: tenant ownership already administers every scope (O65).
  const companies = input.scopes.flatMap((entry): readonly MembershipRequest[] =>
    Match.value(entry).pipe(
      Match.tag('LegalEntity', ({ scopeId }) => [
        {
          at: input.at,
          kind: 'member',
          principalId: input.principalId,
          scopeId,
          tenantId: input.tenantId,
        } satisfies MembershipRequest,
      ]),
      Match.tag('TenantContext', (): readonly MembershipRequest[] => []),
      Match.exhaustive,
    ),
  );
  return [...tenantContext, ...companies];
};

export const bootstrapTenantAccessProgram = Effect.fn('TenantAccessBootstrap.bootstrapTenantAccess')(
  function* bootstrapTenantAccessEffect(
    request: BootstrapTenantAccessRequest,
  ): Effect.fn.Return<BootstrapTenantAccessResult, AccessBootstrapError, BootstrapRequirements> {
    const { scope } = request;
    const tenantId = TenantIdSchema.make(scope.tenantId);
    const ownerPrincipalId = PrincipalIdSchema.make(scope.principalId);
    const legalEntityIds = request.legalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId));
    const at = yield* now();
    const scopes = bootstrapScopesOf(tenantId, legalEntityIds);
    const database: AccessIntentDatabase = yield* CoreDatabase;
    const catalogWriter = yield* AccessCatalogSnapshotWriter;
    const changes = yield* AccessChangesStore;
    const loader = yield* TenantIntentLoader;
    const membershipStore = yield* AccessMembershipStore;
    const projectionWriter = yield* AccessProjectionWriter;

    yield* writeBootstrapScopes(database, scope, { scopes, tenantId }).pipe(Effect.mapError(intentRefused));

    const existingMemberships = yield* membershipStore
      .loadTenantMemberships(scope)
      .pipe(Effect.mapError(intentRefused));
    const missingMemberships = membershipsToWrite(
      existingMemberships,
      ownerMembershipsOf({ at, principalId: ownerPrincipalId, scopes, tenantId }),
    );
    if (missingMemberships.length > 0) {
      yield* membershipStore
        .recordMemberships(scope, { memberships: missingMemberships })
        .pipe(Effect.mapError(intentRefused));
    }

    const intent = yield* loader.loadProjection(scope).pipe(Effect.mapError(intentRefused));
    const installedModuleKeys = [
      ...new Set(intent.scopes.flatMap(({ installations }) => installations.map(({ moduleKey }) => moduleKey))),
    ];
    const catalog = yield* catalogWriter
      .ensureInitialRelease({ installedModuleKeys, modules: request.modules })
      .pipe(Effect.mapError((cause) => bootstrapSourceRefusal('access_bootstrap_catalog_refused', cause)));
    const compiled = compileFullAccessRole(catalog);
    if (Result.isFailure(compiled)) {
      return yield* bootstrapRefusal(
        'access_bootstrap_role_refused',
        compiled.failure.map((failure) => `${failure.code}: ${failure.reason}`).join('; '),
      );
    }
    const roleId = RoleIdSchema.make(
      stableUuid(['ontos.access.bootstrap.role', tenantId, FULL_ACCESS_ROLE_TEMPLATE_KEY].join(':')),
    );
    const loaded = yield* changes.loadTenantChanges(scope).pipe(Effect.mapError(intentRefused));
    if (findRole(loaded.roles, roleId) === undefined) {
      // The role and its first revision are one write of one person, pinned to the release the cells
      // were compiled against; the Novinky store refuses a role without its revision.
      yield* changes
        .recordRole({
          revision: {
            catalogSnapshotId: catalog.id,
            cells: [...compiled.success.cells],
            createdAt: at,
            createdBy: ownerPrincipalId,
            id: RoleRevisionIdSchema.make(
              stableUuid(['ontos.access.bootstrap.role-revision', tenantId, roleId, catalog.id].join(':')),
            ),
            provenance: 'template',
            revision: 1,
            roleId,
            templateKey: FULL_ACCESS_ROLE_TEMPLATE_KEY,
            tenantId,
          } satisfies RoleRevision,
          role: {
            createdAt: at,
            createdBy: ownerPrincipalId,
            id: roleId,
            name: FULL_ACCESS_ROLE_NAME,
            tenantId,
          } satisfies Role,
          scope,
        })
        .pipe(Effect.mapError(intentRefused));
    }
    // The pinned revision is read back: a concurrent bootstrap of this tenant resumes the one it wrote.
    const pins = findRole((yield* changes.loadTenantChanges(scope).pipe(Effect.mapError(intentRefused))).roles, roleId);
    if (pins === undefined) {
      return yield* bootstrapRefusal(
        'access_bootstrap_role_refused',
        `Role ${roleId} of tenant ${tenantId} is neither recorded nor readable`,
      );
    }
    const { cells } = pins.revision;
    yield* writeOwnerAssignments(database, scope, {
      cells,
      principalId: ownerPrincipalId,
      roleId,
      roleRevisionId: pins.revision.id,
      scopes,
      tenantId,
      validFrom: at,
    }).pipe(Effect.mapError(intentRefused));
    const projection = yield* projectionWriter
      .reconcileTenant({ scope })
      .pipe(Effect.mapError((cause) => bootstrapSourceRefusal('access_bootstrap_projection_refused', cause)));
    return {
      catalogSnapshotId: catalog.id,
      cells,
      legalEntityIds,
      ownerPrincipalId,
      projection,
      roleId,
      roleRevisionId: pins.revision.id,
      scopes,
      tenantId,
    } satisfies BootstrapTenantAccessResult;
  },
);

export class TenantAccessBootstrap extends Context.Service<TenantAccessBootstrap, TenantAccessBootstrapService>()(
  '@app/core-runtime/access/bootstrap/bootstrap-tenant-access/TenantAccessBootstrap',
) {}

/** The six writers one bootstrap reads and writes: named once so a composition cannot forget one. */
export type BootstrapRequirements =
  | AccessCatalogSnapshotWriter
  | AccessChangesStore
  | AccessMembershipStore
  | AccessProjectionWriter
  | CoreDatabase
  | TenantIntentLoader;

/**
 * The bootstrap of the process: every phase is bound once, when the runtime is wired, so a request never
 * carries a service requirement of its own (O66) and a missing writer fails where the bootstrap is bound.
 */
export const TenantAccessBootstrapLive: Layer.Layer<TenantAccessBootstrap, never, BootstrapRequirements> = Layer.effect(
  TenantAccessBootstrap,
  Effect.gen(function* tenantAccessBootstrapLayer() {
    const requirements = yield* Effect.context<BootstrapRequirements>();
    return Object.freeze({
      bootstrapTenantAccess: (request: BootstrapTenantAccessRequest) =>
        bootstrapTenantAccessProgram(request).pipe(Effect.provideContext(requirements)),
    });
  }),
);
