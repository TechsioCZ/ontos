import type { AccessDeclaration, OperationalScope } from '@app/core-runtime';
import { declaredAccessCarrier, defineSystemModuleEntrypoint } from '@app/core-runtime';
import { compileFullAccessRole } from '@app/core-runtime/access/bootstrap';
import { stableUuid } from '@app/core-runtime/access/catalog';
import type {
  RoleCellEdit,
  RoleRevisionPlan,
  RoleRevisionPreview,
  RoleWithRevision,
  Assignment,
  CatalogSnapshot,
  CatalogSnapshotEntry,
  Cell,
  RoleRevision,
  RoleRevisionId,
  RoleSummary,
} from '@app/core-runtime/access/changes/role-revision';
import {
  AccessChangesStore,
  CatalogSnapshotIdSchema,
  CellSchema,
  LegalEntityIdSchema,
  RoleIdSchema,
  PrincipalIdSchema,
  RoleRevisionIdSchema,
  RoleTemplateKeySchema,
  findEditableRole,
  planRoleRevision,
  planRoleRevisionPreview,
  previewRoleRevision,
  roleSummaryOf,
  templateKeyOf,
  writeRoleCreation,
  writeRoleRevision,
} from '@app/core-runtime/access/changes/role-revision';
import type { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Match, Option, Result, Schema } from 'effect';
import type {
  AccessAdminProblem,
  CreateAccessRolePayload,
  GetAccessRolePayload,
  GetAccessRoleResponse,
  ListAccessRoleTemplatesPayload,
  ListAccessRoleTemplatesResponse,
  ListAccessRolesPayload,
  ListAccessRolesResponse,
  PreviewAccessRoleEditResponse,
  SaveAccessRoleEditPayload,
  SaveAccessRoleEditResponse,
  AccessRoleEditPayloadSchema,
  AccessCellSchema,
} from '../../shared/access-admin-api.ts';
import {
  AccessRoleSchema,
  GetAccessRoleResponseSchema,
  ListAccessRoleTemplatesResponseSchema,
  ListAccessRolesResponseSchema,
  PreviewAccessRoleEditResponseSchema,
  SaveAccessRoleEditResponseSchema,
} from '../../shared/access-admin-api.ts';
import type { Headers as EffectHeaders } from 'effect/http/Headers';
import { ShellAuthenticationApi } from '../../shared/api.ts';
import { AccessAdminClock } from './clock.ts';
import type { RoleReadScope } from './role-read-scope.ts';
import { decideRoleDeclaration, readableRoleScope, roleIsReadable, roleReadRefusal } from './role-read-scope.ts';
import {
  AccessAdminSession,
  accessAdminConflictProblem,
  accessAdminForbiddenProblem,
  accessAdminInternalProblem,
  accessAdminUnavailableProblem,
  accessAdminUnprocessableProblem,
} from './session.ts';

/** The wire cell type the contract publishes, named once for the decoder. */
type AccessCell = typeof AccessCellSchema.Type;

/** The contract exports the schemas; the BFF names their types once, from those schemas. */
type AccessRole = typeof AccessRoleSchema.Type;

/*
 * Role, the administration half of the Shell BFF: the role list, one role with the people it reaches,
 * the pinned templates the editor offers, the preview of an exact cell set, and the two writes that
 * save one — an edit of an existing Role and a new Role from an explicit template.
 *
 * Three rules shape this module:
 *
 * 1. A role is exact cells pinned to one published release. The editor reads that release through the
 *    templates call, sends back the cells it saw, and the server re-validates every cell against the
 *    release it reads again before writing. Nothing here follows a future permission (O1).
 * 2. The server owns every fact a decision depends on: tenant, acting person, instant, release, head
 *    revision, the affected people, which cells are dangerous and the wording of their effect. A
 *    request carries its selection, the revision it read, the token it saw and an idempotency key —
 *    never a tenant, an actor, an authority or an effect text.
 * 3. Every refusal has one status: a denial is 403, a moved role or release, a stale token or a lost
 *    compare-and-set is 409 for the client to re-read, an unsupported cell set is 422, and an
 *    unavailable gate, store or projection is a retryable 503 that never reads as a denial.
 * 4. A read is narrowed to the roles this person's own authority covers (O88): the tenant context
 *    answer decides the tenant-context roles, and each company that holds a role is asked in that
 *    company's own required scope — never in a scope the browser named. The narrowing happens before
 *    the page is cut and before a holder is counted, so an unreadable role can neither appear nor be
 *    measured; a read that covers nothing is refused, never answered as an empty page.
 *
 * The write is Core's fenced operation (`writeRoleRevision`, `writeRoleCreation`): it writes the
 * revision in this request's own tenant scope and reconciles the tenant, holding the tenant fence and
 * verifying the graph before this module may answer. Passing the gate admits a person to the save;
 * `writeRoleRevision` itself refuses an edit outside their configuration authority — a role, cell or
 * holder beyond a delegated manager's envelope, or a role the manager holds (P8, D10). Administration runs in the tenant context and
 * never needs a selected company (O28). The two writes and the preview stay tenant-context operations
 * in this wave: a company administrator reads their company's roles and does not yet edit them (O88).
 */

const MODULE_KEY = 'shell-super-app';

/** One declared entrypoint per operation, each with its own capability (O1, O27, O62). */
export const accessRolesEntrypoints = Object.freeze({
  create: defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-roles.create',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  detail: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-roles.detail',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  list: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-roles.list',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  preview: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-roles.preview',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  save: defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-roles.save',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  templates: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-roles.templates',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
});

/** Reading the editor is administrative work; saving one changes who holds authority (O23, P8). */
const ROLE_READ = 'sensitive' as const;
const ROLE_WRITE = 'critical' as const;

const roleDeclaration = (
  key: string,
  risk: 'critical' | 'sensitive',
  level: 'extended' | 'manage',
): AccessDeclaration => {
  const entrypoint = Option.getOrThrow(
    Option.fromUndefinedOr(Object.values(accessRolesEntrypoints).find(({ entrypointKey }) => entrypointKey === key)),
  );
  const carrier = declaredAccessCarrier({
    accessDeclaration: {
      key,
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'access', level },
      risk,
      selectors: [],
    },
    entrypoint,
  });
  return Option.getOrThrow(Option.fromUndefinedOr(carrier.accessDeclaration));
};

/** Published with the Shell module's declarations; P1 registers them (O50: never a private allow). */
export const accessRolesDeclarations = Object.freeze({
  create: roleDeclaration('shell-super-app.access-roles.create', ROLE_WRITE, 'manage'),
  detail: roleDeclaration('shell-super-app.access-roles.detail', ROLE_READ, 'extended'),
  list: roleDeclaration('shell-super-app.access-roles.list', ROLE_READ, 'extended'),
  preview: roleDeclaration('shell-super-app.access-roles.preview', ROLE_READ, 'extended'),
  save: roleDeclaration('shell-super-app.access-roles.save', ROLE_WRITE, 'manage'),
  templates: roleDeclaration('shell-super-app.access-roles.templates', ROLE_READ, 'extended'),
});

/** An administration surface is tenant work: it never needs a selected company (O28, P3). */
const ADMIN_LEGAL_ENTITY_SCOPE = 'optional' as const;

const forbidden = accessAdminForbiddenProblem;
const conflict = accessAdminConflictProblem;
const unprocessable = accessAdminUnprocessableProblem;
const unavailable = accessAdminUnavailableProblem;
const internal = accessAdminInternalProblem;

/**
 * Core's refusals, mapped once. A moved role, release or preview and a lost compare-and-set are what
 * a client repairs by re-reading; an unavailable store, projection or intent read is a retry; the
 * remaining codes are cell sets this product does not support.
 */
export const accessRolesFailureProblem = (failure: {
  readonly code: string;
  readonly reason: string;
}): AccessAdminProblem => {
  const text = `${failure.code}: ${failure.reason}`;
  if (
    failure.code === 'access_changes_authority_missing' ||
    failure.code === 'access_changes_agent_cannot_decide' ||
    failure.code === 'access_changes_delegation_out_of_envelope'
  ) {
    return forbidden(text);
  }
  if (
    failure.code === 'access_changes_preview_stale' ||
    failure.code === 'access_changes_record_conflict' ||
    failure.code === 'access_changes_revision_stale' ||
    failure.code === 'access_changes_identity_missing' ||
    failure.code === 'access_changes_role_revision_missing' ||
    failure.code === 'access_changes_write_refused'
  ) {
    return conflict(text);
  }
  if (
    failure.code === 'access_changes_store_unavailable' ||
    failure.code === 'access_intent_unavailable' ||
    failure.code === 'access_projection_write_unavailable' ||
    failure.code === 'access_projection_write_intent_unavailable' ||
    failure.code === 'access_projection_write_fence_refused' ||
    failure.code === 'access_projection_write_scope_missing' ||
    failure.code === 'access_projection_write_plan_refused'
  ) {
    return unavailable();
  }
  return unprocessable(text);
};

/** One Access Roles operation: its own declared entrypoint, asked of the one gate at a Core instant. */
const gateOutcome = Effect.fn('AccessAdminRoles.gateOutcome')(function* decidedByGate(
  scope: OperationalScope,
  declaration: AccessDeclaration,
  now: Date,
) {
  const decision = yield* decideRoleDeclaration(scope, declaration, now, ADMIN_LEGAL_ENTITY_SCOPE);
  return decision.outcome;
});

/**
 * Whether this person can save at all, as the editor's own two write capabilities answer right now.
 * It is the gate's answer, not a form flag and not "is administrator": a stale `true` is harmless
 * because save and create re-ask the gate and re-read the head revision before writing.
 */
const writeAvailability = Effect.fn('AccessAdminRoles.writeAvailability')(function* writesAvailableNow(
  scope: OperationalScope,
  now: Date,
) {
  const [save, create] = yield* Effect.all(
    [gateOutcome(scope, accessRolesDeclarations.save, now), gateOutcome(scope, accessRolesDeclarations.create, now)],
    { concurrency: 1 },
  );
  const reasonOf = (outcome: typeof save) => (outcome === 'UNAVAILABLE' ? 'unavailable' : 'configure_forbidden');
  const withSave =
    save === 'ALLOWED' ? { saveAvailable: true } : { saveAvailable: false, saveUnavailableReason: reasonOf(save) };
  return create === 'ALLOWED'
    ? { ...withSave, createAvailable: true }
    : { ...withSave, createAvailable: false, createUnavailableReason: reasonOf(create) };
});

/** The instant of one administration request, minted at the composition root from the one Clock (D6). */
const coreInstant = AccessAdminClock.pipe(Effect.flatMap(({ now }) => now));

/** An unavailability that keeps Core's own code, so a retry can be told apart from a defect. */
const unavailableBecause = (code: string): AccessAdminProblem => ({
  ...accessAdminUnavailableProblem(),
  detail: `Access administration is temporarily unavailable (${code}). Please retry.`,
});

/** One consistent read of the tenant's roles, its published release and every assignment. */
interface TenantRolesState {
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly catalog: CatalogSnapshot;
  readonly companies: readonly string[];
  readonly roles: readonly RoleWithRevision[];
}

const loadRolesState = Effect.fn('AccessAdminRoles.loadRolesState')(function* loadRoles(scope: OperationalScope) {
  const store = yield* AccessChangesStore;
  const loader = yield* TenantIntentLoader;
  const at = yield* coreInstant;
  const published = yield* store.loadPublishedCatalog().pipe(Effect.mapError(accessRolesFailureProblem));
  if (Option.isNone(published)) {
    // Without a published release no revision can be pinned: nothing is configurable yet.
    return yield* Effect.fail(unavailable());
  }
  // The two reads are independent and hold one connection each, so they run as one bounded batch.
  const [changes, intent] = yield* Effect.all(
    [
      store.loadTenantChanges(scope).pipe(Effect.mapError(accessRolesFailureProblem)),
      loader
        .loadProjection(scope)
        .pipe(
          Effect.mapError((error: { readonly code?: string }) =>
            unavailableBecause(error.code ?? 'access_intent_unavailable'),
          ),
        ),
    ],
    { concurrency: 1 },
  );
  return {
    assignments: intent.scopes.flatMap(({ assignments }) => assignments),
    at,
    catalog: published.value,
    companies: intent.legalEntities.map(({ legalEntityId }) => legalEntityId),
    roles: changes.roles,
  };
});

/** Wire answers are built as plain values and decoded, so the published contract validates each one. */
const encoded = <Value, Input>(
  schema: Schema.Decoder<Value>,
  plain: Input,
  what: string,
): Effect.Effect<Value, AccessAdminProblem> => {
  const decoded = Schema.decodeUnknownResult(schema)(plain);
  return Result.isFailure(decoded)
    ? Effect.fail(internal(`The ${what} answer does not match the published contract: ${decoded.failure.message}`))
    : Effect.succeed(decoded.success);
};

/** The contract's selector arm for a Core selector arm (the vocabulary is Core's own union). */
const plainSelector = (selector: Cell['selector']) =>
  Match.value(selector).pipe(
    Match.tag('targets', ({ recordKeys }) => ({ _tag: 'targets' as const, recordKeys: [...recordKeys] })),
    Match.orElse((named) => ({ _tag: named._tag })),
  );

/**
 * A Core cell in the contract's plain shape. The response is decoded through the contract schema, so
 * branding and validation happen in one place, at the boundary, and never here.
 */
const plainCell = (cell: Cell) => {
  const base = { capabilityKey: cell.capabilityKey, mode: cell.mode, selector: plainSelector(cell.selector) };
  return cell.amountCeiling === undefined ? base : { ...base, amountCeiling: { ...cell.amountCeiling } };
};

/** A wire cell as Core's own model. Both publish one selector vocabulary, so Core's schema decides. */
const decodeCells = (cells: readonly AccessCell[]): Effect.Effect<readonly Cell[], AccessAdminProblem> => {
  const decoded: Cell[] = [];
  for (const cell of cells) {
    const one = Schema.decodeUnknownResult(CellSchema)(cell);
    if (Result.isFailure(one)) {
      return Effect.fail(unprocessable(`The requested cell does not fit the access model: ${one.failure.message}`));
    }
    decoded.push(one.success);
  }
  return Effect.succeed(decoded);
};

const plainHolder = (holder: Assignment['holder']) =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => ({ _tag: 'Principal' as const, principalId })),
    Match.tag('Agent', ({ agentId }) => ({ _tag: 'Agent' as const, agentId })),
    Match.exhaustive,
  );

/** The people one role reaches, as the detail and preview reads name them (never an agent as a person). */
const encodeHolders = (assignments: readonly Assignment[], roleIds: readonly string[]) => {
  const wanted = new Set(roleIds);
  const holders = [];
  for (const assignment of assignments) {
    if (wanted.has(assignment.roleId)) {
      holders.push({
        assignmentIncarnationId: assignment.incarnationId,
        holder: plainHolder(assignment.holder),
        roleId: assignment.roleId,
      });
    }
  }
  return holders;
};

const orderedSummaries = (state: TenantRolesState, readable: RoleReadScope): readonly RoleSummary[] =>
  state.roles
    .flatMap((entry) =>
      roleIsReadable(readable, entry.role.legalEntityId) ? [roleSummaryOf(entry, state.assignments, state.at)] : [],
    )
    .toSorted((left, right) => left.name.localeCompare(right.name) || left.roleId.localeCompare(right.roleId));

/**
 * Which of this tenant's roles this person's authority covers, decided before any row is shaped:
 * before the page is cut, before a holder is counted and before one holder is named (O25, O88).
 */
const readableScopeOf = (
  scope: OperationalScope,
  declaration: AccessDeclaration,
  state: TenantRolesState,
): Effect.Effect<RoleReadScope, AccessAdminProblem, AccessDecisionGate> =>
  readableRoleScope({ companies: state.companies, declaration, now: state.at, scope });

/** A role summary in the contract's plain shape; the response decode brands and validates it. */
const plainRole = (summary: RoleSummary) => {
  const plain = {
    catalogSnapshotId: summary.headRevision.catalogSnapshotId,
    cells: summary.cells.map((cell) => plainCell(cell)),
    holderCount: summary.holderCount,
    id: summary.roleId,
    name: summary.name,
    provenance: summary.headRevision.provenance,
    revision: summary.headRevision.revision,
    revisionId: summary.headRevision.roleRevisionId,
    scope: summary.scope,
  };
  const withCompany = summary.legalEntityId === undefined ? plain : { ...plain, legalEntityId: summary.legalEntityId };
  const { templateKey } = summary.headRevision;
  return templateKey === undefined ? withCompany : { ...withCompany, templateKey };
};

/** A release entry in the contract's own shape, decoded so a mismatch is a defect here, not on the wire. */
/** A release entry in the contract's plain shape; the response decode brands and validates it. */
const encodeCatalogEntry = (entry: CatalogSnapshotEntry) => {
  const plain = {
    capabilityKey: entry.key,
    kind: entry.kind,
    modes: [...entry.modes],
    moduleKey: entry.moduleKey,
    placement: { group: entry.placement.group, level: entry.placement.level },
    risk: entry.risk,
    selectors: [...entry.selectors],
  };
  const withAmount = entry.amountInput === undefined ? plain : { ...plain, amountInput: entry.amountInput };
  return entry.fieldClass === undefined ? withAmount : { ...withAmount, fieldClass: entry.fieldClass };
};

const BLANK_TEMPLATE_KEY = 'blank';
const FULL_ACCESS_TEMPLATE_KEY = 'catalog-full-access';
const COPY_TEMPLATE_PREFIX = 'copy:';

/**
 * The templates this release actually backs: an empty role, "Plný přístup" compiled from the pinned
 * release (O67-Q6), and an exact copy of any role the tenant already holds. A template is an explicit
 * pinned cell set, never a name resolved against today's catalog.
 *
 * `wholeRelease` is the tenant-context answer for this reader. Someone whose authority reaches every
 * role of the tenant is offered the release whole; a reader who reaches only some companies' roles is
 * offered it as those roles pin it — their entries and copies, never "Plný přístup", which is every
 * capability of the release by definition (O88: no operation reads wider than its own authority).
 */
const roleTemplates = (
  catalog: CatalogSnapshot,
  roles: readonly RoleWithRevision[],
  wholeRelease: boolean,
): readonly unknown[] => {
  const blank = {
    catalogSnapshotId: catalog.id,
    cells: [],
    name: 'Blank role',
    source: 'blank',
    templateKey: BLANK_TEMPLATE_KEY,
  };
  const compiled = wholeRelease ? compileFullAccessRole(catalog) : undefined;
  const fullAccess: readonly unknown[] =
    compiled === undefined || Result.isFailure(compiled)
      ? []
      : [
          {
            catalogSnapshotId: catalog.id,
            cells: compiled.success.cells.map((cell) => plainCell(cell)),
            name: 'Plný přístup',
            source: 'catalog_full_access',
            templateKey: FULL_ACCESS_TEMPLATE_KEY,
          },
        ];
  const copies = roles
    .map((role) => ({
      catalogSnapshotId: role.revision.catalogSnapshotId,
      cells: role.revision.cells.map((cell) => plainCell(cell)),
      name: role.role.name,
      source: 'copy_role',
      sourceRoleId: role.role.id,
      templateKey: `${COPY_TEMPLATE_PREFIX}${role.role.id}`,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return [blank, ...fullAccess, ...copies];
};

/**
 * The release entries one templates answer may show: the whole release for a tenant-wide reader, or
 * exactly the entries the readable roles pin their cells to. A cell's label is read from here, so a
 * narrower list still renders every role the caller may see — and reveals no other capability.
 */
const releaseEntriesOf = (
  catalog: CatalogSnapshot,
  roles: readonly RoleWithRevision[],
  wholeRelease: boolean,
): readonly CatalogSnapshotEntry[] => {
  if (wholeRelease) {
    return catalog.entries;
  }
  const pinned = new Set<string>(
    roles.flatMap(({ revision }) => revision.cells.map(({ capabilityKey }) => capabilityKey)),
  );
  return catalog.entries.filter(({ key }) => pinned.has(key));
};

/** The cells one pinned template names, re-derived server-side; the request never supplies them. */
const templateCells = (
  templateKey: string,
  catalog: CatalogSnapshot,
  roles: readonly RoleWithRevision[],
): Effect.Effect<readonly Cell[], AccessAdminProblem> => {
  if (templateKey === BLANK_TEMPLATE_KEY) {
    return Effect.succeed([]);
  }
  if (templateKey === FULL_ACCESS_TEMPLATE_KEY) {
    const compiled = compileFullAccessRole(catalog);
    return Result.isFailure(compiled) ? Effect.fail(unavailable()) : Effect.succeed([...compiled.success.cells]);
  }
  if (templateKey.startsWith(COPY_TEMPLATE_PREFIX)) {
    const source = roles.find(({ role }) => role.id === templateKey.slice(COPY_TEMPLATE_PREFIX.length));
    // A role of another tenant is indistinguishable from a role that does not exist (no enumeration).
    return source === undefined
      ? Effect.fail(forbidden('That template is not available to this tenant.'))
      : Effect.succeed([...source.revision.cells]);
  }
  return Effect.fail(unprocessable(`"${templateKey}" is not a template of the published release.`));
};

const pageOf = <Item>(
  items: readonly Item[],
  payload: { readonly cursor?: string | undefined; readonly limit: number },
) => {
  const offset = payload.cursor === undefined ? 0 : Math.trunc(Number(payload.cursor));
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const next = start + payload.limit;
  return { items: items.slice(start, next), nextCursor: next < items.length ? String(next) : null };
};

/** The revision a save writes is named by its idempotency key, so a retry resumes instead of forking. */
const targetIds = (scope: OperationalScope, idempotencyKey: string, roleId?: string) => {
  const roleIdValue = RoleIdSchema.make(
    roleId ?? stableUuid(['ontos.shell.access-roles.role', scope.tenantId, idempotencyKey].join(':')),
  );
  return {
    roleId: roleIdValue,
    roleRevisionId: RoleRevisionIdSchema.make(
      stableUuid(['ontos.shell.access-roles.revision', scope.tenantId, roleIdValue, idempotencyKey].join(':')),
    ),
  };
};

const previewOf = (
  role: RoleWithRevision,
  state: TenantRolesState,
  cells: readonly Cell[],
  plan: RoleRevisionPlan,
  targetRevisionId: RoleRevisionId,
): RoleRevisionPreview =>
  previewRoleRevision({ assignments: state.assignments, at: state.at, cells, plan, role, targetRevisionId });

/** The head revision of a role that has just been written, as the editor reads it back. */
const writtenSummary = (
  role: RoleWithRevision,
  state: TenantRolesState,
  scope: OperationalScope,
  edit: RoleCellEdit,
  writtenRevisionId: RoleRevisionId,
): RoleSummary => {
  const base = {
    catalogSnapshotId: state.catalog.id,
    cells: [...edit.cells],
    createdAt: state.at,
    createdBy: PrincipalIdSchema.make(scope.principalId),
    id: writtenRevisionId,
    provenance: Option.isSome(templateKeyOf(role.revision)) ? 'customer_changed' : 'manual',
    revision: role.revision.revision + 1,
    roleId: role.role.id,
    tenantId: role.revision.tenantId,
  } satisfies RoleRevision;
  const revision: RoleRevision =
    role.revision.templateKey === undefined ? base : { ...base, templateKey: role.revision.templateKey };
  return roleSummaryOf({ revision, role: role.role }, state.assignments, state.at);
};

/** One administration request: the session headers, the decoded payload and its idempotency key. */
export interface AccessAdminWrite<Payload> {
  readonly headers: Headers;
  readonly idempotencyKey: string;
  readonly payload: Payload;
}

/** The six operations of the Role editor, stated once for the bound and the unbound service. */
interface RolesOperations<Requirements> {
  /** A new Role with its first revision, from one explicit and pinned template (P2). */
  readonly create: (
    input: AccessAdminWrite<CreateAccessRolePayload>,
  ) => Effect.Effect<AccessRole, AccessAdminProblem, Requirements>;
  readonly detail: (
    headers: Headers,
    payload: GetAccessRolePayload,
  ) => Effect.Effect<GetAccessRoleResponse, AccessAdminProblem, Requirements>;
  readonly list: (
    headers: Headers,
    payload: ListAccessRolesPayload,
  ) => Effect.Effect<ListAccessRolesResponse, AccessAdminProblem, Requirements>;
  readonly preview: (
    headers: Headers,
    payload: PreviewAccessRoleEditPayload,
  ) => Effect.Effect<PreviewAccessRoleEditResponse, AccessAdminProblem, Requirements>;
  /** The one write of an existing Role: exact cells, pinned release, stale-proof prerequisite. */
  readonly save: (
    input: AccessAdminWrite<SaveAccessRoleEditPayload>,
  ) => Effect.Effect<SaveAccessRoleEditResponse, AccessAdminProblem, Requirements>;
  readonly templates: (
    headers: Headers,
    payload: ListAccessRoleTemplatesPayload,
  ) => Effect.Effect<ListAccessRoleTemplatesResponse, AccessAdminProblem, Requirements>;
}

/** The service as its callers see it: its methods state the ports the composition must provide. */
/** The service as a caller sees it: the layer binds every port once, so a method asks for none (O66). */
export type AccessAdminRolesBffService = RolesOperations<never>;

/** The preview request is the edit request: the same role, revision, release and cells. */
export type PreviewAccessRoleEditPayload = typeof AccessRoleEditPayloadSchema.Type;

export class AccessAdminRolesBff extends Context.Service<AccessAdminRolesBff, AccessAdminRolesBffService>()(
  '@app/shell-super-app/api/access-admin/roles/AccessAdminRolesBff',
) {}

const requireScope = (headers: Headers): Effect.Effect<OperationalScope, AccessAdminProblem, AccessAdminSession> =>
  AccessAdminSession.pipe(Effect.flatMap(({ requireTenantContext }) => requireTenantContext(headers)));

const ROLE_NOT_AVAILABLE = 'That role is not available to this tenant.';
const COMPANY_NOT_AVAILABLE = 'That company is not available to this tenant.';

const roleOrRefuse = (state: TenantRolesState, roleId: string): Effect.Effect<RoleWithRevision, AccessAdminProblem> =>
  // A role of another tenant is indistinguishable from a role that does not exist (no enumeration).
  Effect.fromOption(findEditableRole(state.roles, RoleIdSchema.make(roleId)), () => forbidden(ROLE_NOT_AVAILABLE));

const requireRelease = (state: TenantRolesState, catalogSnapshotId: string): Effect.Effect<void, AccessAdminProblem> =>
  state.catalog.id === catalogSnapshotId
    ? Effect.void
    : Effect.fail(
        conflict(
          `the editor was built from release ${catalogSnapshotId}, but ${state.catalog.id} is published; re-read the role`,
        ),
      );

const accessAdminOperations = {
  create: Effect.fn('AccessAdminRoles.create')(function* createRole({
    headers,
    idempotencyKey,
    payload,
  }: AccessAdminWrite<CreateAccessRolePayload>) {
    const scope = yield* requireScope(headers);
    const state = yield* loadRolesState(scope);
    // A new role lives in the company it names, so that company must admit the create in its own scope
    // (O88); creation itself stays a tenant-context write in this wave, as the save is.
    const readable = yield* readableScopeOf(scope, accessRolesDeclarations.create, state);
    if (!readable.tenant) {
      return yield* Effect.fail(roleReadRefusal());
    }
    if (!roleIsReadable(readable, payload.scope.kind === 'company' ? payload.scope.legalEntityId : undefined)) {
      // A company outside this person's authority is indistinguishable from a company that does not exist.
      return yield* Effect.fail(forbidden(COMPANY_NOT_AVAILABLE));
    }
    yield* requireRelease(state, payload.catalogSnapshotId);
    // A role is created EMPTY (arbitration with P8b, replacing a create-preview): its cells arrive
    // through the editor's preview and its per-cell confirmations, never through creation.
    if (payload.cells.length > 0) {
      return yield* Effect.fail(
        unprocessable(
          'a role is created empty; add its cells in the editor, which previews them and asks for each dangerous effect',
        ),
      );
    }
    // The template key must name a template of the pinned release, so no invented template is recorded;
    // a copy names only a readable role, so another company's role reads like no template at all.
    yield* templateCells(
      payload.templateKey,
      state.catalog,
      state.roles.filter(({ role }) => roleIsReadable(readable, role.legalEntityId)),
    );
    const ids = targetIds(scope, idempotencyKey);
    const creation = {
      catalogSnapshotId: CatalogSnapshotIdSchema.make(state.catalog.id),
      cells: [],
      decidedAt: yield* coreInstant,
      name: payload.name,
      scope,
      targetRevisionId: ids.roleRevisionId,
      targetRoleId: ids.roleId,
      templateKey: RoleTemplateKeySchema.make(payload.templateKey),
    };
    const created = yield* writeRoleCreation(
      payload.scope.kind === 'company'
        ? { ...creation, legalEntityId: LegalEntityIdSchema.make(payload.scope.legalEntityId) }
        : creation,
    ).pipe(Effect.mapError(accessRolesFailureProblem));
    const createdRole = {
      catalogSnapshotId: state.catalog.id,
      cells: [],
      holderCount: 0,
      id: created.roleId,
      name: payload.name,
      provenance: 'template',
      revision: 1,
      revisionId: created.roleRevisionId,
      scope: payload.scope.kind,
      templateKey: payload.templateKey,
    };
    // A company role answers its company, as every later read does, so the editor never labels it tenant-wide.
    return yield* encoded(
      AccessRoleSchema,
      payload.scope.kind === 'company' ? { ...createdRole, legalEntityId: payload.scope.legalEntityId } : createdRole,
      'created role',
    );
  }),

  detail: Effect.fn('AccessAdminRoles.detail')(function* roleDetail(headers: Headers, payload: GetAccessRolePayload) {
    const scope = yield* requireScope(headers);
    const state = yield* loadRolesState(scope);
    // Which roles this person's authority covers is decided first, then the role is looked up in the
    // intent this request already read: no name, cell or holder is shaped before both answers hold.
    const [readable, role] = yield* Effect.all(
      [readableScopeOf(scope, accessRolesDeclarations.detail, state), roleOrRefuse(state, payload.roleId)],
      { concurrency: 1 },
    );
    if (!roleIsReadable(readable, role.role.legalEntityId)) {
      // A role outside this person's authority is indistinguishable from a role that does not exist.
      return yield* Effect.fail(forbidden(ROLE_NOT_AVAILABLE));
    }
    const summary = roleSummaryOf(role, state.assignments, state.at);
    return yield* encoded(
      GetAccessRoleResponseSchema,
      {
        holderCount: summary.holderCount,
        holders: encodeHolders(state.assignments, [summary.roleId]),
        role: plainRole(summary),
      },
      'role detail',
    );
  }),

  list: Effect.fn('AccessAdminRoles.list')(function* listRoles(headers: Headers, payload: ListAccessRolesPayload) {
    const scope = yield* requireScope(headers);
    const state = yield* loadRolesState(scope);
    // The page is cut after the narrowing: an unreadable role can shift no cursor and count nobody.
    const readable = yield* readableScopeOf(scope, accessRolesDeclarations.list, state);
    const page = pageOf(orderedSummaries(state, readable), payload);
    return yield* encoded(
      ListAccessRolesResponseSchema,
      { items: page.items.map((value) => plainRole(value)), nextCursor: page.nextCursor },
      'role list',
    );
  }),

  preview: Effect.fn('AccessAdminRoles.preview')(function* previewRoleEdit(
    headers: Headers,
    payload: PreviewAccessRoleEditPayload,
  ) {
    const scope = yield* requireScope(headers);
    const state = yield* loadRolesState(scope);
    // Authority is decided in the role's own company scope before any revision, cell or holder of it
    // is planned or answered, so a role outside it reads exactly like a missing one.
    const readable = yield* readableScopeOf(scope, accessRolesDeclarations.preview, state);
    yield* requireRelease(state, payload.catalogSnapshotId);
    const [role, cells] = yield* Effect.all([roleOrRefuse(state, payload.roleId), decodeCells(payload.cells)], {
      concurrency: 1,
    });
    if (!roleIsReadable(readable, role.role.legalEntityId)) {
      return yield* Effect.fail(forbidden(ROLE_NOT_AVAILABLE));
    }
    const plan = yield* planRoleRevisionPreview({
      catalog: state.catalog,
      cells,
      confirmedEffects: [],
      expectedRoleRevisionId: RoleRevisionIdSchema.make(payload.expectedRoleRevisionId),
      role,
      targetRevisionId: role.revision.id,
    }).pipe(Effect.mapError(accessRolesFailureProblem));
    const preview = previewOf(role, state, cells, plan, role.revision.id);
    const successor = Option.match(plan.edit, {
      onNone: () => [...role.revision.cells],
      onSome: (edit) => [...edit.cells],
    });
    return yield* encoded(
      PreviewAccessRoleEditResponseSchema,
      {
        added: plan.addedCells.map((cell) => plainCell(cell)),
        affectedAgentCount: preview.agentCount,
        affectedHolders: encodeHolders(state.assignments, [role.role.id]),
        affectedHumanCount: preview.humanCount,
        cells: successor.map((cell) => plainCell(cell)),
        changes: !plan.unchanged,
        dangerous: plan.dangerous.map((danger) => ({ ...danger })),
        previewToken: preview.fingerprint,
        removed: plan.removedCells.map((cell) => plainCell(cell)),
        requiresNamedEffect: plan.dangerous.length > 0,
      },
      'role preview',
    );
  }),

  save: Effect.fn('AccessAdminRoles.save')(function* saveRoleEdit({
    headers,
    idempotencyKey,
    payload,
  }: AccessAdminWrite<SaveAccessRoleEditPayload>) {
    const scope = yield* requireScope(headers);
    const state = yield* loadRolesState(scope);
    // Authority is decided in the role's own company scope before any revision, cell or holder of it
    // is planned or answered, so a role outside it reads exactly like a missing one.
    const readable = yield* readableScopeOf(scope, accessRolesDeclarations.save, state);
    yield* requireRelease(state, payload.catalogSnapshotId);
    const [role, cells] = yield* Effect.all([roleOrRefuse(state, payload.roleId), decodeCells(payload.cells)], {
      concurrency: 1,
    });
    if (!roleIsReadable(readable, role.role.legalEntityId)) {
      return yield* Effect.fail(forbidden(ROLE_NOT_AVAILABLE));
    }
    const ids = targetIds(scope, idempotencyKey, role.role.id);
    // The token is checked first: a client that never saw this cell set is told to re-preview
    // before it is told which of its cells would need a named effect.
    const planned = {
      catalog: state.catalog,
      cells,
      expectedRoleRevisionId: RoleRevisionIdSchema.make(payload.expectedRoleRevisionId),
      role,
      targetRevisionId: ids.roleRevisionId,
    };
    const previewPlan = yield* planRoleRevisionPreview({ ...planned, confirmedEffects: [] }).pipe(
      Effect.mapError(accessRolesFailureProblem),
    );
    const preview = previewOf(role, state, cells, previewPlan, ids.roleRevisionId);
    // A retry of a save that already committed finds the role at its own target revision: Core replays
    // it (and reconciles), so the token of the revision it replaced is not asked again.
    if (!previewPlan.replayed && preview.fingerprint !== payload.previewToken) {
      return yield* Effect.fail(conflict('the preview this save was built from is stale; preview the cell set again'));
    }
    const plan = yield* planRoleRevision({
      ...planned,
      confirmedEffects: payload.confirmedEffects.map(({ effect, slot }) => ({ effect, slot })),
    }).pipe(Effect.mapError(accessRolesFailureProblem));
    if (Option.isNone(plan.edit)) {
      const summary = roleSummaryOf(role, state.assignments, state.at);
      return yield* encoded(
        SaveAccessRoleEditResponseSchema,
        { added: [], affectedHolderCount: summary.holderCount, removed: [], role: plainRole(summary) },
        'unchanged role',
      );
    }
    const edit = Option.getOrThrow(plan.edit);
    const written = yield* writeRoleRevision({
      catalogSnapshotId: CatalogSnapshotIdSchema.make(state.catalog.id),
      decidedAt: yield* coreInstant,
      edit,
      scope,
    }).pipe(Effect.mapError(accessRolesFailureProblem));
    const summary = writtenSummary(role, state, scope, edit, written.roleRevisionId);
    return yield* encoded(
      SaveAccessRoleEditResponseSchema,
      {
        added: plan.addedCells.map((cell) => plainCell(cell)),
        affectedHolderCount: preview.holderCount,
        removed: plan.removedCells.map((cell) => plainCell(cell)),
        role: plainRole(summary),
      },
      'saved role',
    );
  }),

  templates: Effect.fn('AccessAdminRoles.templates')(function* listRoleTemplates(
    headers: Headers,
    payload: ListAccessRoleTemplatesPayload,
  ) {
    const scope = yield* requireScope(headers);
    const state = yield* loadRolesState(scope);
    // A copy template is another role's name and exact cells, so it is bounded by the same narrowing
    // as the list and cut after it. The published release itself names no role and no holder.
    const readable = yield* readableScopeOf(scope, accessRolesDeclarations.templates, state);
    const availability = yield* writeAvailability(scope, state.at);
    const readableRoles = state.roles.filter(({ role }) => roleIsReadable(readable, role.legalEntityId));
    // The tenant-context answer also decides whether the published release is this reader's to see
    // whole; a company's administrator reads the release only as far as their own roles pin it (O88).
    const wholeRelease = readable.tenant;
    const page = pageOf(roleTemplates(state.catalog, readableRoles, wholeRelease), payload);
    return yield* encoded(
      ListAccessRoleTemplatesResponseSchema,
      {
        catalogSnapshotId: state.catalog.id,
        entries: releaseEntriesOf(state.catalog, readableRoles, wholeRelease).map((value) => encodeCatalogEntry(value)),
        publishedAt: state.catalog.publishedAt.toISOString(),
        templates: page.items,
        ...availability,
      },
      'role templates',
    );
  }),
};

/** The requirements of one operation, taken from the operation itself. */
type OperationRequirements<Operation> = Operation extends (
  ...parameters: never[]
) => Effect.Effect<unknown, unknown, infer Requirements>
  ? Requirements
  : never;

/** Every port the Role editor reads and writes, taken from the operations so none is restated by hand. */
export type AccessAdminRolesRequirements = OperationRequirements<
  (typeof accessAdminOperations)[keyof typeof accessAdminOperations]
>;

/** The Role editor of this process: the composition provides its ports once (O66). */
export const AccessAdminRolesBffLive: Layer.Layer<AccessAdminRolesBff, never, AccessAdminRolesRequirements> =
  Layer.effect(
    AccessAdminRolesBff,
    Effect.gen(function* accessAdminRolesBffLayer() {
      const context = yield* Effect.context<AccessAdminRolesRequirements>();
      const operations = yield* Effect.succeed(accessAdminOperations);
      return {
        create: (input) => operations.create(input).pipe(Effect.provideContext(context)),
        detail: (headers, payload) => operations.detail(headers, payload).pipe(Effect.provideContext(context)),
        list: (headers, payload) => operations.list(headers, payload).pipe(Effect.provideContext(context)),
        preview: (headers, payload) => operations.preview(headers, payload).pipe(Effect.provideContext(context)),
        save: (input) => operations.save(input).pipe(Effect.provideContext(context)),
        templates: (headers, payload) => operations.templates(headers, payload).pipe(Effect.provideContext(context)),
      };
    }),
  );

/** The handler's headers as the web `Headers` a session port reads, from the runtime's own domain type. */
const asHeaders = (input: EffectHeaders): Headers => new Headers(Object.entries(input));

export const accessAdminRolesGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'accessAdminRoles', (handlers) =>
  handlers
    .handle('listAccessRoles', ({ payload, request }) =>
      AccessAdminRolesBff.pipe(Effect.flatMap((bff) => bff.list(asHeaders(request.headers), payload))),
    )
    .handle('getAccessRole', ({ payload, request }) =>
      AccessAdminRolesBff.pipe(Effect.flatMap((bff) => bff.detail(asHeaders(request.headers), payload))),
    )
    .handle('listAccessRoleTemplates', ({ payload, request }) =>
      AccessAdminRolesBff.pipe(Effect.flatMap((bff) => bff.templates(asHeaders(request.headers), payload))),
    )
    .handle('previewAccessRoleEdit', ({ payload, request }) =>
      AccessAdminRolesBff.pipe(Effect.flatMap((bff) => bff.preview(asHeaders(request.headers), payload))),
    )
    .handle('saveAccessRoleEdit', ({ headers, payload, request }) =>
      AccessAdminRolesBff.pipe(
        Effect.flatMap((bff) =>
          bff.save({ headers: asHeaders(request.headers), idempotencyKey: headers['idempotency-key'], payload }),
        ),
      ),
    )
    .handle('createAccessRole', ({ headers, payload, request }) =>
      AccessAdminRolesBff.pipe(
        Effect.flatMap((bff) =>
          bff.create({ headers: asHeaders(request.headers), idempotencyKey: headers['idempotency-key'], payload }),
        ),
      ),
    ),
);
