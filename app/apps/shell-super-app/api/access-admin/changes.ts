import type {
  AccessChangesCommandsService,
  AccessChangesItemView,
  AccessChangesPreview,
  AccessChangesReceipt,
  AccessChangesView,
  AffectedHolder,
  CellChange,
  CatalogSnapshotEntry,
  RoleCellChange,
  RoleSummary,
  UndoSkip,
} from '@app/core-runtime/access/changes/commands';
import { AccessChangesCommands } from '@app/core-runtime/access/changes/commands';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { AccessDeclaration, OperationalScope } from '@app/core-runtime';
import { declaredAccessDeclaration, defineSystemModuleEntrypoint } from '@app/core-runtime';
import { Context, DateTime, Effect, Layer, Match, Schema } from 'effect';
import type {
  AccessAdminProblem,
  DecideAccessChangesPayload,
  DecideAccessChangesResponse,
  ListAccessChangesPayload,
  ListAccessChangesResponse,
  PreviewAccessChangesPayload,
  PreviewAccessChangesResponse,
} from '../../shared/access-admin-api.ts';
import {
  DecideAccessChangesResponseSchema,
  ListAccessChangesResponseSchema,
  PreviewAccessChangesResponseSchema,
} from '../../shared/access-admin-api.ts';
import type { RoleReadScope } from './role-read-scope.ts';
import { readableCompanies, roleIsReadable } from './role-read-scope.ts';
import type { AccessAdminSessionService } from './session.ts';
import type { AccessChangesWriteGate } from './write-gate.ts';
import { AccessChangesWriteAvailability } from './write-gate.ts';
import {
  AccessAdminSession,
  accessAdminConflictProblem,
  accessAdminFailureDetail,
  accessAdminForbiddenProblem,
  accessAdminInternalProblem,
  accessAdminUnprocessableProblem,
  accessAdminSavedPendingProblem,
  accessAdminUnavailableProblem,
} from './session.ts';

/*
 * Novinky v oprávněních: the release list, the preview, adoption, decline and undo as the Shell BFF
 * serves them. This module owns three things and nothing else:
 *
 *   1. the capability every Novinky operation is decided by — one declared entrypoint per operation,
 *      asked of the one gate with a Core-minted instant and the request's tenant context;
 *   2. the translation between the wire shapes a browser sees and the Core command seam;
 *   3. the refusal taxonomy: a denial is 403, a lost compare-and-set, a stale preview or a release
 *      that moved is a 409 the caller repairs by re-reading, an unprocessable decision is 422, and
 *      an unavailable gate, store or projection is a retryable 503 that is never a denial.
 *
 * Everything a decision depends on is derived server-side: the tenant, the acting human, the
 * instant, the release, the configuration authority, the exact cells and every identifier. A request
 * carries a selection, the release it was prepared against, the preview token the person saw, the
 * effect they confirmed and an idempotency key. A release is never published from a request.
 *
 * Tenant admission is not company authority (O88). After the operation's own tenant-context answer,
 * each company that holds a role of the tenant is asked that same declaration in its own required
 * scope, exactly as the Role editor asks (`role-read-scope.ts`). A role is shown only when its company
 * admitted it, and an item only when every role it reaches is shown: an item's cells, holders and
 * suggested roles all come from those roles, and an adoption, decline or undo of it writes into them.
 * An item outside that authority reads, and refuses, exactly like an item that does not exist.
 */

/**
 * O89: an admin declaration belongs to the module that owns its entrypoint, and the catalog enforces
 * it (O27). The Shell BFF APIs are entrypoints of the `shell-super-app` module, not of the `core.shell`
 * contribution module, so their capability keys are `shell-super-app.access-*`.
 */
const MODULE_KEY = 'shell-super-app';

/** The three entrypoints of the Novinky surface, each with its own capability (O1, O62). */
export const accessChangesEntrypoints = Object.freeze({
  decide: defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-changes.decide',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  decideTenant: defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-changes.decide-tenant',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  list: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-changes.list',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  preview: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-changes.preview',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
  previewTenant: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'shell-super-app.access-changes.preview-tenant',
    moduleKey: MODULE_KEY,
    role: 'api',
  }),
});

type ChangesEntrypoint = (typeof accessChangesEntrypoints)[keyof typeof accessChangesEntrypoints];

/**
 * Reading Novinky and previewing a decision are administrative work, never business data, so every
 * capability is `kind: 'admin'` — which Core refuses at routine risk — and runs in tenant context.
 * `selectors` stays empty: Novinky reaches roles, not records. `declaredAccessCarrier` validates each
 * declaration against its own entrypoint at definition time, so a wrong classification fails here
 * instead of becoming a silently weaker capability (O5, O62).
 */
const declaredDeclaration = (
  key: string,
  entrypoint: ChangesEntrypoint,
  level: 'extended' | 'manage',
): AccessDeclaration | undefined =>
  declaredAccessDeclaration({
    accessDeclaration: {
      key,
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'access', level },
      risk: 'sensitive',
      selectors: [],
    },
    entrypoint,
  }).accessDeclaration;

/** Published with the Shell module's declarations by P1 (O50: never a private allow of this file). */
export const accessChangesDeclarations = Object.freeze({
  /**
   * The company pair. A company decision is gated with `required` on a scope narrowed to that company
   * (O88): `gateScopeOf` drops the company for any other setting, so one optional declaration could
   * never gate a company decision at all.
   */
  decide: declaredDeclaration('shell-super-app.access-changes.decide', accessChangesEntrypoints.decide, 'manage'),
  /** The tenant pair: a decision for the whole tenant, acceptable only to tenant-level authority. */
  decideTenant: declaredDeclaration(
    'shell-super-app.access-changes.decide-tenant',
    accessChangesEntrypoints.decideTenant,
    'manage',
  ),
  list: declaredDeclaration('shell-super-app.access-changes.list', accessChangesEntrypoints.list, 'extended'),
  preview: declaredDeclaration('shell-super-app.access-changes.preview', accessChangesEntrypoints.preview, 'extended'),
  previewTenant: declaredDeclaration(
    'shell-super-app.access-changes.preview-tenant',
    accessChangesEntrypoints.previewTenant,
    'extended',
  ),
});

/**
 * A company decision needs the company validated by Core's scope resolution, which does not exist yet:
 * `OperationalScopeResolver` validates a company already on the principal, so a BFF would have to forge
 * a trusted context to ask. Until Core exposes that narrowing, a company target is refused with the
 * retryable unavailable the surface already uses - never evaluated in tenant context, which `optional`
 * would silently do (O88).
 */
const companyTargetPending = () => accessAdminUnavailableProblem();

/**
 * Novinky reads and tenant decisions are tenant work and never depend on a company selection (O28, P3);
 * a company decision is the one operation that must be gated inside the company it names.
 */
const TENANT_LEGAL_ENTITY_SCOPE = 'optional' as const;
const COMPANY_LEGAL_ENTITY_SCOPE = 'required' as const;

/**
 * The gate's own answers. A denial — and a `NEEDS_APPROVAL` that no Novinky operation can honour,
 * because a release decision is never a proposal — is 403; an engine that cannot decide is the
 * retryable 503, never a denial.
 */
export const accessChangesGateProblem = (outcome: 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE'): AccessAdminProblem =>
  outcome === 'UNAVAILABLE'
    ? accessAdminUnavailableProblem()
    : accessAdminForbiddenProblem('Novinky v oprávněních is not available to this person.');

/**
 * The decision refusals, mapped once. A missing configuration authority is a denial. A stale
 * preview, a moved release, an item already decided and an adoption that cannot be undone are the
 * caller's signal to re-read the tenant's changes. Everything else is the request's own refusal: an
 * unnamed effect, a sensitive item inside a batch, a target the module does not publish.
 */
export const accessChangesFailureProblem = (failure: {
  readonly code: string;
  readonly reason: string;
}): AccessAdminProblem => {
  const text = accessAdminFailureDetail(failure);
  const authority =
    failure.code === 'access_changes_authority_missing' ||
    failure.code === 'access_changes_command_authority_absent' ||
    failure.code === 'access_changes_agent_cannot_decide' ||
    failure.code === 'access_changes_delegation_out_of_envelope';
  const conflict =
    failure.code === 'access_changes_adoption_not_undoable' ||
    failure.code === 'access_changes_command_conflict' ||
    failure.code === 'access_changes_command_release_missing' ||
    failure.code === 'access_changes_identity_missing' ||
    failure.code === 'access_changes_item_not_pending' ||
    failure.code === 'access_changes_item_unavailable' ||
    failure.code === 'access_changes_preview_stale' ||
    failure.code === 'access_changes_record_conflict' ||
    failure.code === 'access_changes_revision_stale' ||
    failure.code === 'access_changes_undo_conflict' ||
    failure.code === 'access_changes_undo_not_an_adoption';
  if (failure.code === 'access_changes_command_saved_projection_pending') {
    return accessAdminSavedPendingProblem();
  }
  return Match.value({ authority, conflict, unavailable: failure.code === 'access_changes_command_unavailable' }).pipe(
    Match.when({ authority: true }, () => accessAdminForbiddenProblem(text)),
    Match.when({ conflict: true }, () => accessAdminConflictProblem(text)),
    Match.when({ unavailable: true }, () => accessAdminUnavailableProblem()),
    Match.orElse(() => accessAdminUnprocessableProblem(text)),
  );
};

/** The one way this module adds an optional property: absent stays absent, never `undefined`. */
const withOptional = <Base extends object, Extra extends object>(base: Base, extra: Extra): Base & Extra => ({
  ...base,
  ...extra,
});

/** One affected holder in the wire vocabulary, where an agent is never folded into a person. */
const plainHolder = ({ assignmentIncarnationId, holder, roleId }: AffectedHolder) => {
  const wireHolder = Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => ({ _tag: 'human' as const, principalId })),
    Match.tag('Agent', ({ agentId }) => ({ _tag: 'agent' as const, agentId })),
    Match.exhaustive,
  );
  return { assignmentIncarnationId, holder: wireHolder, roleId };
};

/** The published entry of a release, as the screen reads it (Core's `key` is the wire capability). */
const plainEntry = (entry: CatalogSnapshotEntry) =>
  withOptional(
    withOptional(
      {
        capabilityKey: entry.key,
        kind: entry.kind,
        modes: [...entry.modes],
        moduleKey: entry.moduleKey,
        placement: entry.placement,
        risk: entry.risk,
        selectors: [...entry.selectors],
      },
      entry.amountInput === undefined ? {} : { amountInput: entry.amountInput },
    ),
    entry.fieldClass === undefined ? {} : { fieldClass: entry.fieldClass },
  );

/** One cell a decision changes, with the role it changes: the before/after a person confirms. */
const plainCellChange = ({ cell, roleId }: CellChange) => ({
  cell: withOptional(
    { capabilityKey: cell.capabilityKey, mode: cell.mode, selector: cell.selector },
    cell.amountCeiling === undefined ? {} : { amountCeiling: cell.amountCeiling },
  ),
  roleId,
});

/** One role as the decision leaves it: the exact cells before and after, and the revision replaced. */
const plainRoleChange = ({ after, before, expectedRevisionId, roleId }: RoleCellChange) => ({
  after: [...after],
  before: [...before],
  expectedRevisionId,
  roleId,
});

/** One cell a decision deliberately left alone, with the reason it was unavailable (D7d). */
const plainSkip = ({ capabilityKey, reason, roleId, slot }: UndoSkip) => ({ capabilityKey, reason, roleId, slot });

const holderCounts = (holders: readonly AffectedHolder[]) => {
  let humans = 0;
  let agents = 0;
  for (const { holder } of holders) {
    humans += Match.value(holder).pipe(
      Match.tag('Principal', () => 1),
      Match.tag('Agent', () => 0),
      Match.exhaustive,
    );
    agents += Match.value(holder).pipe(
      Match.tag('Principal', () => 0),
      Match.tag('Agent', () => 1),
      Match.exhaustive,
    );
  }
  return { agents, humans };
};

const plainChangeFields = (item: AccessChangesItemView) => {
  const { agents, humans } = holderCounts(item.holders);
  return {
    addedCells: item.addedCells.map(plainCellChange),
    affectedAgentCount: agents,
    affectedHumanCount: humans,
    batchEligible: item.batchEligible,
    capabilityKey: item.capabilityKey,
    catalogSnapshotId: item.catalogSnapshotId,
    holders: item.holders.map(plainHolder),
    id: item.id,
    kind: item.kind,
    lineageFrom: [...item.lineageFrom],
    removedCells: item.removedCells.map(plainCellChange),
    requiresIndividualDecision: item.requiresIndividualDecision,
    risk: item.risk,
    status: item.status,
    suggestedRoleIds: [...item.suggestedRoleIds],
    widens: item.widens,
  };
};

const plainChange = (item: AccessChangesItemView) =>
  withOptional(
    withOptional(plainChangeFields(item), item.entry === undefined ? {} : { entry: plainEntry(item.entry) }),
    item.namedEffect === undefined ? {} : { namedEffect: item.namedEffect },
  );

/** One role as both the Novinky screen and the role editor read it: one shape, never two. */
const plainRole = (role: RoleSummary) =>
  withOptional(
    withOptional(
      {
        catalogSnapshotId: role.headRevision.catalogSnapshotId,
        cells: [...role.cells],
        holderCount: role.holderCount,
        id: role.roleId,
        name: role.name,
        provenance: role.headRevision.provenance,
        revision: role.headRevision.revision,
        revisionId: role.headRevision.roleRevisionId,
        scope: role.scope,
      },
      role.legalEntityId === undefined ? {} : { legalEntityId: role.legalEntityId },
    ),
    role.headRevision.templateKey === undefined ? {} : { templateKey: role.headRevision.templateKey },
  );

/**
 * The BFF's own translation, exported so a suite can prove it faithfully: the flags a browser must
 * never infer (`widening`, `routineBatchEligible`) and the exact cells a decision changes come from
 * Core's item view, not from the item's risk.
 */
export const accessChangesWire = Object.freeze({
  cellChange: plainCellChange,
  change: plainChange,
  role: plainRole,
  skip: plainSkip,
  /** The one shape the write gate travels in, so a browser never composes its own answer. */
  writeAvailability: ({ available, reason }: AccessChangesWriteGate) => ({ available, reason }),
});

/** A failure of this module's own translation: the answer it built is not the published contract. */
const contractFailure = (issue: { readonly message: string }): AccessAdminProblem =>
  accessAdminInternalProblem(`the Novinky answer did not match its published contract: ${issue.message}`);

/** The part of the tenant's Novinky one person's company authority covers (O88). */
interface ReadableChanges {
  readonly items: readonly AccessChangesItemView[];
  /** The ids of the roles shown, which bound every role id an answer may carry. */
  readonly roleIds: ReadonlySet<string>;
  readonly roles: readonly RoleSummary[];
}

/**
 * The view narrowed to the roles whose company admitted this operation. A role the view does not
 * know has no company to be admitted by, so an item suggesting one is withheld too: unknown is never
 * read as readable.
 */
const readableChangesOf = (view: AccessChangesView, readable: RoleReadScope): ReadableChanges => {
  const roles = view.roles.filter((role) => roleIsReadable(readable, role.legalEntityId));
  const roleIds = new Set<string>(roles.map(({ roleId }) => roleId));
  const items = view.items.filter(({ suggestedRoleIds }) => suggestedRoleIds.every((roleId) => roleIds.has(roleId)));
  return { items, roleIds, roles };
};

/** The companies a view's roles live in: Core's own facts, never a request's company. */
const companiesOf = (view: AccessChangesView): readonly string[] =>
  view.roles.flatMap(({ legalEntityId }) => (legalEntityId === undefined ? [] : [legalEntityId]));

/**
 * The one refusal for an item this person may not see, worded as Core words an unknown item, so an
 * item of another company and an item that does not exist are indistinguishable.
 */
const itemsUnavailable = (itemIds: readonly string[]): AccessAdminProblem =>
  accessChangesFailureProblem({
    code: 'access_changes_item_unavailable',
    reason: `one of ${itemIds.join(', ')} is not part of this tenant's changes`,
  });

/** A selection names only items this person may see; anything else reads like a missing item. */
const requireReadableItems = (
  changes: ReadableChanges,
  itemIds: readonly string[],
): Effect.Effect<void, AccessAdminProblem> => {
  const shown = new Set<string>(changes.items.map(({ id }) => id));
  return itemIds.every((itemId) => shown.has(itemId)) ? Effect.void : Effect.fail(itemsUnavailable(itemIds));
};

/** Every role id one answer carries, so a preview can be proved to stay inside the shown roles. */
const previewRoleIds = (previewed: AccessChangesPreview): readonly string[] => [
  ...previewed.addedCells.map(({ roleId }) => roleId),
  ...previewed.removedCells.map(({ roleId }) => roleId),
  ...previewed.roleChanges.map(({ roleId }) => roleId),
  ...previewed.skipped.map(({ roleId }) => roleId),
  ...previewed.items.flatMap(({ holders, suggestedRoleIds }) => [
    ...suggestedRoleIds,
    ...holders.map(({ roleId }) => roleId),
  ]),
];

/**
 * One page of the tenant's items. The cursor is the index of the next item in the tenant's own
 * order, so a page is stable for the same intent and a caller that received a conflict re-reads.
 */
const pageOf = (
  view: ReadableChanges,
  release: AccessChangesView['release'],
  payload: ListAccessChangesPayload,
  writeAvailability: AccessChangesWriteGate,
): Effect.Effect<ListAccessChangesResponse, AccessAdminProblem> => {
  const parsed = payload.cursor === undefined ? 0 : Math.trunc(Number(payload.cursor));
  const start = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  const next = start + payload.limit;
  return Schema.decodeUnknownEffect(ListAccessChangesResponseSchema)({
    catalogSnapshotId: release?.catalogSnapshotId ?? null,
    items: view.items.slice(start, next).map(plainChange),
    nextCursor: next < view.items.length ? String(next) : null,
    roles: view.roles.map(plainRole),
    writeAvailability: accessChangesWire.writeAvailability(writeAvailability),
  }).pipe(Effect.mapError(contractFailure));
};

export interface AccessChangesBffService {
  /** Adopt, decline or undo: one endpoint, one decision, one tenant fence (D15, D24). */
  readonly decide: (
    headers: Headers,
    payload: DecideAccessChangesPayload,
  ) => Effect.Effect<DecideAccessChangesResponse, AccessAdminProblem>;
  readonly list: (
    headers: Headers,
    payload: ListAccessChangesPayload,
  ) => Effect.Effect<ListAccessChangesResponse, AccessAdminProblem>;
  readonly preview: (
    headers: Headers,
    payload: PreviewAccessChangesPayload,
  ) => Effect.Effect<PreviewAccessChangesResponse, AccessAdminProblem>;
}

export class AccessChangesBff extends Context.Service<AccessChangesBff, AccessChangesBffService>()(
  '@app/shell-super-app/api/access-admin/changes/AccessChangesBff',
) {}

/** The collaborators of the BFF, as the request's context provides them. */
export type AccessChangesBffContext =
  | AccessAdminSession
  | AccessDecisionGate
  | AccessChangesCommands
  | AccessChangesWriteAvailability;

const idempotencyKeyOf = (headers: Headers): string => headers.get('idempotency-key') ?? '';

export const makeAccessChangesBff = (context: Context.Context<AccessChangesBffContext>): AccessChangesBffService => {
  const commands: AccessChangesCommandsService = Context.get(context, AccessChangesCommands);
  const gate: AccessDecisionService = Context.get(context, AccessDecisionGate);
  const session: AccessAdminSessionService = Context.get(context, AccessAdminSession);
  const writeAvailability: AccessChangesWriteGate = Context.get(context, AccessChangesWriteAvailability);

  /** The one decision this payload names, with the identities Core derives from the idempotency key. */
  const decideCommand = (
    scope: OperationalScope,
    payload: DecideAccessChangesPayload,
    idempotencyKey: string,
  ): Effect.Effect<AccessChangesReceipt, AccessAdminProblem> => {
    if (payload.decision === 'decline') {
      return commands
        .decline(scope, { idempotencyKey, itemIds: [...payload.itemIds] })
        .pipe(Effect.mapError(accessChangesFailureProblem));
    }
    if (payload.decision === 'adopt') {
      return commands
        .adopt(
          scope,
          withOptional(
            {
              catalogSnapshotId: payload.catalogSnapshotId,
              idempotencyKey,
              itemIds: [...payload.itemIds],
              previewToken: payload.previewToken,
            },
            payload.namedEffect === undefined ? {} : { namedEffect: payload.namedEffect },
          ),
        )
        .pipe(Effect.mapError(accessChangesFailureProblem));
    }
    return commands
      .undo(scope, {
        catalogSnapshotId: payload.catalogSnapshotId,
        idempotencyKey,
        itemIds: [...payload.itemIds],
        previewToken: payload.previewToken,
      })
      .pipe(Effect.mapError(accessChangesFailureProblem));
  };

  /**
   * The one hand-off every Novinky handler starts with: P1's trusted tenant context of this request,
   * then this operation's own capability at a Core-minted instant. No handler trusts a body-supplied
   * tenant, actor, administrator flag or configuration authority.
   */
  const admit = Effect.fn('AccessChangesBff.admit')(function* admitNovinkyOperation(
    headers: Headers,
    carrier: AccessDeclaration | undefined,
    legalEntityScope: typeof TENANT_LEGAL_ENTITY_SCOPE | typeof COMPANY_LEGAL_ENTITY_SCOPE,
  ) {
    const scope = yield* session.requireTenantContext(headers);
    const question: GateInput = {
      carrier: { accessDeclaration: carrier },
      legalEntityScope,
      now: yield* DateTime.nowAsDate,
      scope,
    };
    const decision = yield* gate.decide(question);
    if (decision.outcome !== 'ALLOWED') {
      return yield* Effect.fail(accessChangesGateProblem(decision.outcome));
    }
    return { now: question.now, scope };
  });

  /**
   * The tenant's Novinky as this person's company authority covers them. The tenant context already
   * admitted the operation, so only each company is asked, in its own required scope, with the same
   * declaration (O88). Nothing of the view is answered before this narrowing.
   */
  const readable = Effect.fn('AccessChangesBff.readable')(function* readableNovinky(
    admitted: { readonly now: Date; readonly scope: OperationalScope },
    declaration: AccessDeclaration | undefined,
  ) {
    if (declaration === undefined) {
      // A declaration-less operation was refused by the gate above; it never reaches a company.
      return yield* Effect.fail(accessChangesGateProblem('DENIED'));
    }
    const view = yield* commands.read(admitted.scope).pipe(Effect.mapError(accessChangesFailureProblem));
    const companies = yield* readableCompanies(gate.decide, {
      companies: companiesOf(view),
      declaration,
      now: admitted.now,
      scope: admitted.scope,
    });
    return { readable: readableChangesOf(view, { companies, tenant: true }), view };
  });

  const list: AccessChangesBffService['list'] = Effect.fn('AccessChangesBff.list')(function* listNovinky(
    headers: Headers,
    payload: ListAccessChangesPayload,
  ) {
    const admitted = yield* admit(headers, accessChangesDeclarations.list, TENANT_LEGAL_ENTITY_SCOPE);
    // The page is cut after the narrowing: a withheld item shifts no cursor and names no role.
    const { readable: changes, view } = yield* readable(admitted, accessChangesDeclarations.list);
    return yield* pageOf(changes, view.release, payload, writeAvailability);
  });

  const preview: AccessChangesBffService['preview'] = Effect.fn('AccessChangesBff.preview')(function* previewNovinky(
    headers: Headers,
    payload: PreviewAccessChangesPayload,
  ) {
    if (payload.legalEntityId !== null) {
      return yield* Effect.fail(companyTargetPending());
    }
    const admitted = yield* admit(headers, accessChangesDeclarations.previewTenant, TENANT_LEGAL_ENTITY_SCOPE);
    const { scope } = admitted;
    const { readable: changes, view } = yield* readable(admitted, accessChangesDeclarations.previewTenant);
    // Authority first: an item outside it is refused before Core plans it, so no Core refusal can
    // name one of its roles.
    yield* requireReadableItems(changes, payload.itemIds);
    if (view.release === undefined || view.release.catalogSnapshotId !== payload.catalogSnapshotId) {
      return yield* Effect.fail(
        accessAdminConflictProblem('the published release moved since this screen was read; reload Novinky'),
      );
    }
    const previewed = yield* commands
      .preview(scope, { itemIds: [...payload.itemIds], mode: payload.decision })
      .pipe(Effect.mapError(accessChangesFailureProblem));
    if (!previewRoleIds(previewed).every((roleId) => changes.roleIds.has(roleId))) {
      // An undo reaches the roles its adoption wrote, which are the item's own suggested roles; a
      // preview that names any other role is refused like the item it came from.
      return yield* Effect.fail(itemsUnavailable(payload.itemIds));
    }
    return yield* Schema.decodeUnknownEffect(PreviewAccessChangesResponseSchema)({
      addedCells: previewed.addedCells.map(plainCellChange),
      affectedAgentCount: previewed.preview.agentCount,
      affectedHumanCount: previewed.preview.humanCount,
      individualItemIds: [...previewed.individualItemIds],
      // The preview answers for the decision it names: an adoption is described per item, an undo
      // by the exact cells it would restore or remove plus what it leaves alone.
      items: previewed.items.map(plainChange),
      legalEntityId: payload.legalEntityId,
      previewToken: previewed.token,
      removedCells: previewed.removedCells.map(plainCellChange),
      requiresNamedEffect: previewed.individualItemIds.length > 0,
      roleChanges: previewed.roleChanges.map(plainRoleChange),
      skipped: previewed.skipped.map(plainSkip),
    }).pipe(Effect.mapError(contractFailure));
  });

  const decide: AccessChangesBffService['decide'] = Effect.fn('AccessChangesBff.decide')(function* decideNovinky(
    headers: Headers,
    payload: DecideAccessChangesPayload,
  ) {
    if (payload.legalEntityId !== null) {
      return yield* Effect.fail(companyTargetPending());
    }
    const admitted = yield* admit(headers, accessChangesDeclarations.decideTenant, TENANT_LEGAL_ENTITY_SCOPE);
    if (!writeAvailability.available) {
      // The ship gate is closed: the surface ships the screen and the preview, never a partial write.
      return yield* Effect.fail(accessAdminUnavailableProblem());
    }
    const idempotencyKey = idempotencyKeyOf(headers);
    if (idempotencyKey.length === 0) {
      return yield* Effect.fail(
        accessAdminUnprocessableProblem('a decision needs an idempotency-key header so a retry resumes it'),
      );
    }
    // Core refuses a role outside the decider's configuration basis, but its refusal names that role;
    // the company authority is therefore decided here first, so such an item reads like a missing one.
    const { readable: changes } = yield* readable(admitted, accessChangesDeclarations.decideTenant);
    yield* requireReadableItems(changes, payload.itemIds);
    const receipt = yield* decideCommand(admitted.scope, payload, idempotencyKey);
    return yield* Schema.decodeUnknownEffect(DecideAccessChangesResponseSchema)({
      catalogSnapshotId: receipt.catalogSnapshotId,
      decisionIds: [...receipt.decisionIds],
      legalEntityId: payload.legalEntityId,
      skipped: receipt.skipped.map(plainSkip),
    }).pipe(Effect.mapError(contractFailure));
  });

  return Object.freeze({ decide, list, preview });
};

export const AccessChangesBffLive: Layer.Layer<AccessChangesBff, never, AccessChangesBffContext> = Layer.effect(
  AccessChangesBff,
  Effect.gen(function* accessChangesBffLayer() {
    const context = yield* Effect.context<AccessChangesBffContext>();
    return makeAccessChangesBff(context);
  }),
);

/**
 * The ship gate travels with the surface, so a composition imports one module: provide
 * `AccessChangesWritesClosedLive` now, and `accessChangesWritesProvenLive` only once P14's real-gate
 * suite has proved adopt, decline and undo (see `./write-gate.ts`).
 */
export {
  AccessChangesWriteAvailability,
  AccessChangesWritesClosedLive,
  WRITES_PENDING_REAL_GATE,
} from './write-gate.ts';
export type { AccessChangesWriteGate } from './write-gate.ts';
