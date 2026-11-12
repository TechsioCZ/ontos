import type {
  AccessChangesCommandsService,
  AccessChangesItemView,
  AccessChangesPreview,
  AccessChangesReceipt,
  AccessChangesView,
  RoleSummary,
} from '@app/core-runtime/access/changes/commands';
import {
  AccessChangesCommands,
  AccessChangesError,
  AccessPreviewFingerprintSchema,
  CellSchema,
  accessChangesError,
} from '@app/core-runtime/access/changes/commands';
import {
  AccessChangeDecisionIdSchema,
  AccessChangeItemIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import type { OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { Context, DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ShellTestAccessGate } from '../support/access-decision-double.ts';
import { makeShellTestAccessGate } from '../support/access-decision-double.ts';
import type {
  AccessAdminProblem,
  DecideAccessChangesPayload,
  ListAccessChangesPayload,
  PreviewAccessChangesPayload,
} from '../../shared/access-admin-api.ts';
import { AccessCompanyIdSchema } from '../../shared/access-admin-api.ts';
import {
  AccessChangesWriteAvailability,
  WRITES_PENDING_REAL_GATE,
  accessChangesDeclarations,
  accessChangesEntrypoints,
  accessChangesFailureProblem,
  accessChangesGateProblem,
  accessChangesWire,
  makeAccessChangesBff,
} from '../../api/access-admin/changes.ts';
import type { AccessAdminSessionService } from '../../api/access-admin/session.ts';
import {
  AccessAdminSession,
  accessAdminAuthenticationRequiredProblem,
  accessAdminSavedPendingProblem,
  accessAdminUnavailableProblem,
} from '../../api/access-admin/session.ts';

/*
 * Novinky v oprávněních, unit level: the BFF's own decisions — which capability each operation is
 * decided by, what a caller may send, and which refusal becomes which status. The Core plans, the
 * preview fingerprint and the fenced write are Core's, exercised in the Core suites; here the
 * command seam is a scripted port, so a failure of the BFF's own wiring cannot hide inside them.
 */

const decode = Schema.decodeUnknownSync;
/** A fixed instant with no ambient clock: the same `Date` the model decodes everywhere. */
const instant = (day: number, hour: number): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, day, hour)));
const TENANT = decode(TenantIdSchema)('11111111-1111-4111-8111-111111111111');
const HUMAN = decode(PrincipalIdSchema)('22222222-2222-4222-8222-222222222222');
const OTHER_HUMAN = decode(PrincipalIdSchema)('33333333-3333-4333-8333-333333333333');
const CATALOG = decode(CatalogSnapshotIdSchema)('55555555-5555-4555-8555-555555555555');
const OTHER_CATALOG = decode(CatalogSnapshotIdSchema)('55555555-5555-4555-8555-555555555556');
const ROLE = decode(RoleIdSchema)('66666666-6666-4666-8666-666666666666');
const REVISION = decode(RoleRevisionIdSchema)('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const INCARNATION = decode(AssignmentIncarnationIdSchema)('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const COMPANY = decode(AccessCompanyIdSchema)('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const ITEM = decode(AccessChangeItemIdSchema)('77777777-7777-4777-8777-777777777777');
const OTHER_ITEM = decode(AccessChangeItemIdSchema)('88888888-8888-4888-8888-888888888888');
const DECISION = decode(AccessChangeDecisionIdSchema)('99999999-9999-4999-8999-999999999999');
const CAPABILITY = decode(CapabilityKeySchema)('party.registry.party.read');
const DIGEST = decode(CatalogDigestSchema)('c'.repeat(64));
const FINGERPRINT = decode(AccessPreviewFingerprintSchema)('a'.repeat(64));
const CELL = decode(CellSchema)({ capabilityKey: 'party.registry.party.read', mode: 'run', selector: { _tag: 'all' } });
const IDEMPOTENCY_KEY = 'novinky-adopt-1';

const tenantScope: OperationalScope = {
  authContextRef: 'better-auth-session:unit-test',
  authMethod: 'session',
  correlationId: 'unit-test-correlation',
  principalId: HUMAN,
  tenantId: TENANT,
};

const itemView = (overrides: Partial<AccessChangesItemView> = {}): AccessChangesItemView => ({
  addedCells: [],
  batchEligible: false,
  capabilityKey: CAPABILITY,
  catalogSnapshotId: CATALOG,
  createdAt: instant(3, 9),
  holders: [
    {
      assignmentIncarnationId: INCARNATION,
      holder: { _tag: 'Principal', principalId: OTHER_HUMAN },
      roleId: ROLE,
    },
  ],
  id: ITEM,
  kind: 'new',
  lineageFrom: [],
  namedEffect: `${CAPABILITY} [read/sensitive]`,
  removedCells: [],
  requiresIndividualDecision: true,
  risk: 'sensitive',
  status: 'pending',
  suggestedRoleIds: [ROLE],
  widens: true,
  ...overrides,
});

const roleSummary = (): RoleSummary => ({
  cells: [],
  headRevision: {
    catalogSnapshotId: CATALOG,
    cells: [],
    createdAt: instant(1, 9),
    createdBy: HUMAN,
    provenance: 'manual',
    revision: 2,
    roleRevisionId: REVISION,
  },
  holderCount: 1,
  name: 'Správce fakturace',
  roleId: ROLE,
  scope: 'tenant',
});

const preview = () => ({
  agentCount: 0,
  fingerprint: FINGERPRINT,
  holders: [],
  humanCount: 1,
  items: [],
});

const view = (overrides: Partial<AccessChangesView> = {}): AccessChangesView => ({
  decisions: [],
  items: [itemView()],
  preview: preview(),
  release: {
    catalogSnapshotId: CATALOG,
    digest: DIGEST,
    entries: [],
    publishedAt: instant(2, 9),
  },
  roles: [roleSummary()],
  tenantId: TENANT,
  ...overrides,
});

const previewAnswer = (overrides: Partial<AccessChangesPreview> = {}): AccessChangesPreview => ({
  addedCells: [],
  individualItemIds: [ITEM],
  items: [itemView()],
  preview: preview(),
  removedCells: [],
  roleChanges: [],
  skipped: [],
  token: FINGERPRINT,
  ...overrides,
});

const receipt = (): AccessChangesReceipt => ({
  catalogSnapshotId: CATALOG,
  decisionIds: [DECISION],
  skipped: [],
  tenantId: TENANT,
});

interface CommandCalls {
  readonly adopt: AdoptCall[];
  readonly decline: DeclineCall[];
  readonly read: OperationalScope[];
  readonly undo: UndoCall[];
}

type AdoptCall = Parameters<AccessChangesCommandsService['adopt']>[1];
type DeclineCall = Parameters<AccessChangesCommandsService['decline']>[1];
type UndoCall = Parameters<AccessChangesCommandsService['undo']>[1];

interface ScriptedCommands {
  readonly calls: CommandCalls;
  readonly service: AccessChangesCommandsService;
}

const isScriptedFailure = <Value extends object>(
  scripted: Value | AccessChangesError,
): scripted is AccessChangesError => Schema.is(AccessChangesError)(scripted);

const scriptedCommands = (options: {
  readonly adopt?: AccessChangesReceipt | AccessChangesError;
  readonly decline?: AccessChangesReceipt | AccessChangesError;
  readonly preview?: AccessChangesPreview | AccessChangesError;
  readonly read?: AccessChangesView | AccessChangesError;
  readonly undo?: AccessChangesReceipt | AccessChangesError;
}): ScriptedCommands => {
  const calls: CommandCalls = { adopt: [], decline: [], read: [], undo: [] };
  const service: AccessChangesCommandsService = {
    adopt: (_scope, input) => {
      calls.adopt.push(input);
      const answer = options.adopt ?? receipt();
      return isScriptedFailure(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
    decline: (_scope, input) => {
      calls.decline.push(input);
      const answer = options.decline ?? receipt();
      return isScriptedFailure(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
    preview: () => {
      const answer = options.preview ?? previewAnswer();
      return isScriptedFailure(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
    read: (scope) => {
      calls.read.push(scope);
      const answer = options.read ?? view();
      return isScriptedFailure(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
    readRelease: () => Effect.succeed(Option.none()),
    roleNames: () => Effect.succeed(new Map()),
    undo: (_scope, input) => {
      calls.undo.push(input);
      const answer = options.undo ?? receipt();
      return isScriptedFailure(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
  };
  return { calls, service };
};

/** A session that resolves: the person and tenant of the request (no company selection, O28). */
const sessionOf = (scope: OperationalScope): AccessAdminSessionService => ({
  requireTenantContext: () => Effect.succeed(scope),
});

/** A session the integration refused, with the exact problem it hands the handler. */
const sessionRefused = (problem: AccessAdminProblem): AccessAdminSessionService => ({
  requireTenantContext: () => Effect.fail(problem),
});

const headers = (idempotencyKey?: string): Headers => {
  const result = new Headers();
  if (idempotencyKey !== undefined) {
    result.set('idempotency-key', idempotencyKey);
  }
  return result;
};

/** The gate a composition reports once P14's real-gate suite has proved adopt/decline/undo. */
const writesProven = { available: true, reason: 'proven by the real-gate suite' } as const;

/**
 * A BFF over the scripted seam. `writes` is the ship gate: the shipped state is closed (read and
 * preview only), so a suite that wants a write closed must say so, and one that exercises a write
 * has to state that the proof exists.
 */
const bffOf = (options: {
  readonly commands: AccessChangesCommandsService;
  readonly gate?: ShellTestAccessGate;
  readonly session?: AccessAdminSessionService;
  readonly writes?: boolean;
}) =>
  makeAccessChangesBff(
    Context.make(AccessChangesCommands, options.commands).pipe(
      Context.add(AccessAdminSession, options.session ?? sessionOf(tenantScope)),
      Context.add(
        AccessDecisionGate,
        options.gate ?? makeShellTestAccessGate({ answers: {}, defaultAnswer: 'allowed' }),
      ),
      Context.add(
        AccessChangesWriteAvailability,
        options.writes === false ? { available: false, reason: WRITES_PENDING_REAL_GATE } : writesProven,
      ),
    ),
  );

const listPayload: ListAccessChangesPayload = { limit: 20 };

const previewPayload: PreviewAccessChangesPayload = {
  catalogSnapshotId: CATALOG,
  decision: 'adopt',
  itemIds: [ITEM],
  legalEntityId: null,
};

const decidePayload = (overrides: Partial<DecideAccessChangesPayload> = {}): DecideAccessChangesPayload => ({
  catalogSnapshotId: CATALOG,
  decision: 'adopt',
  itemIds: [ITEM],
  legalEntityId: null,
  previewToken: FINGERPRINT,
  ...overrides,
});

/** The problem an effect refused with; a test asserts on it instead of on a thrown value. */
const problemOf = (effect: Effect.Effect<unknown, AccessAdminProblem>) => Effect.flip(effect);

it.effect('decides every Novinky operation by its own declared admin capability in tenant context', () =>
  Effect.gen(function* decidesByOwnCapability() {
    const gate = makeShellTestAccessGate({ answers: {}, defaultAnswer: 'allowed' });
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service, gate });

    yield* bff.list(headers(), listPayload);
    yield* bff.preview(headers(), previewPayload);

    expect(gate.decisions).toHaveLength(2);
    const [listAsk, previewAsk] = gate.decisions;
    expect(listAsk?.carrier.accessDeclaration?.key).toBe('shell-super-app.access-changes.list');
    // A tenant decision asks the tenant pair: the company pair is gated inside the company it names.
    expect(previewAsk?.carrier.accessDeclaration?.key).toBe('shell-super-app.access-changes.preview-tenant');
    // A management title is not a company grant: the screen is decided in tenant context (O28).
    expect(listAsk?.legalEntityScope).toBe('optional');
    expect(previewAsk?.legalEntityScope).toBe('optional');
    expect(listAsk?.scope.tenantId).toBe(TENANT);
    expect(listAsk?.scope.legalEntityId).toBeUndefined();
  }),
);

it.effect('declares Novinky as administrative capabilities, never a routine allow', () =>
  Effect.gen(function* declaresAdministrativeCapabilities() {
    yield* Effect.void;
    for (const declaration of Object.values(accessChangesDeclarations)) {
      expect(declaration).toBeDefined();
      if (declaration === undefined) {
        continue;
      }
      expect(declaration.kind).toBe('admin');
      expect(declaration.risk).not.toBe('routine');
      expect(declaration.modes).toEqual(['run']);
      expect(declaration.selectors).toEqual([]);
    }
    expect(accessChangesDeclarations.list?.key).toBe(accessChangesEntrypoints.list.entrypointKey);
    expect(accessChangesDeclarations.preview?.key).toBe(accessChangesEntrypoints.preview.entrypointKey);
    expect(accessChangesDeclarations.decide?.key).toBe(accessChangesEntrypoints.decide.entrypointKey);
    expect(accessChangesEntrypoints.decide.access).toBe('write');
    expect(accessChangesEntrypoints.list.access).toBe('read');
    // O89/O27: the capability of a BFF entrypoint is rooted in the module that owns the entrypoint,
    // so a declaration key can never be borrowed from another module (the catalog refuses it).
    for (const entrypoint of Object.values(accessChangesEntrypoints)) {
      expect(entrypoint.moduleKey).toBe('shell-super-app');
      expect(entrypoint.entrypointKey.startsWith(`${entrypoint.moduleKey}.`)).toBe(true);
    }
    for (const declaration of Object.values(accessChangesDeclarations)) {
      expect(declaration?.key.startsWith('shell-super-app.')).toBe(true);
    }
  }),
);

it.effect('refuses a denied list with 403 and never reaches the tenant state', () =>
  Effect.gen(function* refusesDeniedList() {
    const commands = scriptedCommands({});
    const bff = bffOf({
      commands: commands.service,
      gate: makeShellTestAccessGate({ defaultAnswer: 'denied' }),
    });
    const failure = yield* problemOf(bff.list(headers(), listPayload));
    expect(failure.status).toBe(403);
    expect(commands.calls.read).toHaveLength(0);
  }),
);

it.effect('keeps an unavailable gate retryable instead of reporting it as a denial', () =>
  Effect.gen(function* keepsUnavailableRetryable() {
    const commands = scriptedCommands({});
    const bff = bffOf({
      commands: commands.service,
      gate: makeShellTestAccessGate({ defaultAnswer: 'unavailable' }),
    });
    const failure = yield* problemOf(bff.list(headers(), listPayload));
    expect(failure.status).toBe(503);
    expect(commands.calls.read).toHaveLength(0);
    expect(accessChangesGateProblem('UNAVAILABLE').status).toBe(503);
    expect(accessChangesGateProblem('DENIED').status).toBe(403);
    expect(accessChangesGateProblem('NEEDS_APPROVAL').status).toBe(403);
  }),
);

it.effect('answers 401 for a request with no session and never asks the gate', () =>
  Effect.gen(function* answersUnauthenticated() {
    const gate = makeShellTestAccessGate({ defaultAnswer: 'allowed' });
    const commands = scriptedCommands({});
    const bff = bffOf({
      commands: commands.service,
      gate,
      session: sessionRefused(accessAdminAuthenticationRequiredProblem()),
    });
    const failure = yield* problemOf(bff.list(headers(), listPayload));
    expect(failure.status).toBe(401);
    expect(gate.decisions).toHaveLength(0);
  }),
);

it.effect('ships Novinky read-and-preview only until the real gate proves every write', () =>
  Effect.gen(function* shipsReadOnlyUntilProven() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service, writes: false });
    // The shipped gate is closed, and its reason is the one a person is shown.
    expect(accessChangesWire.writeAvailability({ available: false, reason: WRITES_PENDING_REAL_GATE })).toEqual({
      available: false,
      reason: WRITES_PENDING_REAL_GATE,
    });
    // Reading and previewing still work: the surface ships the screen, never a partial write.
    yield* bff.list(headers(), listPayload);
    yield* bff.preview(headers(), previewPayload);
    expect(commands.calls.read).toHaveLength(2);
    // Every write is refused with a retryable 503 — never a denial, never a silent no-op.
    for (const decision of ['adopt', 'decline', 'undo'] as const) {
      const failure = yield* problemOf(bff.decide(headers(IDEMPOTENCY_KEY), decidePayload({ decision })));
      expect(failure.status).toBe(503);
    }
    expect(commands.calls.adopt).toHaveLength(0);
    expect(commands.calls.decline).toHaveLength(0);
    expect(commands.calls.undo).toHaveLength(0);
  }),
);

it.effect('refuses a company target while Core cannot narrow the trusted scope to that company', () =>
  Effect.gen(function* refusesCompanyTarget() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    // The company has to be validated by Core's scope resolution before a company decision may be
    // gated at all: gating it in tenant context is exactly what O88 forbids, so it is refused instead.
    for (const effect of [
      bff.preview(headers(), { ...previewPayload, legalEntityId: COMPANY }),
      bff.decide(headers(IDEMPOTENCY_KEY), decidePayload({ legalEntityId: COMPANY })),
    ]) {
      const failure = yield* problemOf(effect);
      expect(failure.status).toBe(503);
    }
    expect(commands.calls.read).toHaveLength(0);
    expect(commands.calls.adopt).toHaveLength(0);
  }),
);

it.effect('answers for the target it was asked for, and never for an implied one', () =>
  Effect.gen(function* answersForItsTarget() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    const previewed = yield* bff.preview(headers(), previewPayload);
    const decided = yield* bff.decide(headers(IDEMPOTENCY_KEY), decidePayload());
    // A tenant decision says so on the wire: an omitted target would read as "whatever the screen had".
    expect(previewed.legalEntityId).toBeNull();
    expect(decided.legalEntityId).toBeNull();
  }),
);

it.effect('opts the writes in only through the gate the composition provides', () =>
  Effect.gen(function* optsWritesIn() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    yield* bff.decide(headers(IDEMPOTENCY_KEY), decidePayload());
    expect(commands.calls.adopt).toHaveLength(1);
  }),
);

it.effect('pages the tenant items by their own order and reports the release once', () =>
  Effect.gen(function* pagesTenantItems() {
    const many = [
      itemView(),
      itemView({ id: OTHER_ITEM, status: 'adopted' }),
      itemView({ id: OTHER_ITEM, status: 'declined' }),
    ];
    const commands = scriptedCommands({ read: view({ items: many }) });
    const bff = bffOf({ commands: commands.service });
    const first = yield* bff.list(headers(), { limit: 2 });
    expect(first.items.map(({ id }) => id)).toEqual([ITEM, OTHER_ITEM]);
    expect(first.nextCursor).toBe('2');
    expect(first.catalogSnapshotId).toBe(CATALOG);
    const second = yield* bff.list(headers(), { cursor: '2', limit: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // The item carries what a person decides on: its capability, its roles and who it reaches.
    expect(first.items[0]?.capabilityKey).toBe(CAPABILITY);
    expect(first.items[0]?.suggestedRoleIds).toEqual([ROLE]);
    expect(first.items[0]?.affectedHumanCount).toBe(1);
    expect(first.items[0]?.addedCells).toEqual([]);
    expect(first.items[0]?.batchEligible).toBe(false);
    expect(first.items[0]?.widens).toBe(true);
    expect(first.roles.map(({ id }) => id)).toEqual([ROLE]);
  }),
);

it.effect('previews an adoption of pending items and an undo of adopted ones', () =>
  Effect.gen(function* previewsByDecision() {
    const modes: string[] = [];
    const commands = scriptedCommands({});
    const spy: AccessChangesCommandsService = {
      ...commands.service,
      preview: (_scope, input) => {
        modes.push(input.mode);
        return Effect.succeed(previewAnswer());
      },
    };
    const bff = bffOf({ commands: spy });
    const adoption = yield* bff.preview(headers(), previewPayload);
    expect(modes).toEqual(['adopt']);
    expect(adoption.previewToken).toBe(FINGERPRINT);
    expect(adoption.affectedHumanCount).toBe(1);
    expect(adoption.affectedAgentCount).toBe(0);
    // One sensitive item: the answer names it, so the UI never guesses which items are batchable.
    expect(adoption.requiresNamedEffect).toBe(true);
    expect(adoption.individualItemIds).toEqual([ITEM]);
    expect(adoption.items.map(({ id }) => id)).toEqual([ITEM]);

    // An adopted item previews its undo, and the payload's own decision says which preview it is.
    const undoCommands = scriptedCommands({ read: view({ items: [itemView({ status: 'adopted' })] }) });
    const undoBff = bffOf({
      commands: {
        ...undoCommands.service,
        preview: (_scope, input) => {
          modes.push(input.mode);
          return Effect.succeed(previewAnswer());
        },
      },
    });
    yield* undoBff.preview(headers(), { ...previewPayload, decision: 'undo' });
    expect(modes).toEqual(['adopt', 'undo']);
  }),
);

it.effect('reports the exact cells, the batch rule and the undo skips of a previewed decision', () =>
  Effect.gen(function* reportsExactPreview() {
    const commands = scriptedCommands({
      preview: previewAnswer({
        addedCells: [{ cell: CELL, roleId: ROLE }],
        items: [itemView({ addedCells: [{ cell: CELL, roleId: ROLE }] })],
        roleChanges: [{ after: [], before: [], expectedRevisionId: REVISION, roleId: ROLE }],
        skipped: [
          {
            capabilityKey: CAPABILITY,
            reason: 'capability_not_published',
            roleId: ROLE,
            slot: 'party.registry.party.read run all',
          },
        ],
      }),
    });
    const bff = bffOf({ commands: commands.service });
    const answer = yield* bff.preview(headers(), previewPayload);
    expect(answer.items.map(({ id }) => id)).toEqual([ITEM]);
    // The published contract carries the exact role deltas and the undo skips, not a summary of them.
    expect(answer.roleChanges).toEqual([{ after: [], before: [], expectedRevisionId: REVISION, roleId: ROLE }]);
    expect(answer.items[0]?.addedCells).toEqual([{ cell: CELL, roleId: ROLE }]);
    expect(answer.skipped).toEqual([
      {
        capabilityKey: CAPABILITY,
        reason: 'capability_not_published',
        roleId: ROLE,
        slot: 'party.registry.party.read run all',
      },
    ]);
    // The translation a browser sees: exact cells per role, and the skips an undo will not perform.
    expect(accessChangesWire.cellChange({ cell: CELL, roleId: ROLE })).toEqual({
      cell: { capabilityKey: CAPABILITY, mode: 'run', selector: { _tag: 'all' } },
      roleId: ROLE,
    });
    expect(
      accessChangesWire.skip({
        capabilityKey: CAPABILITY,
        reason: 'capability_not_published',
        roleId: ROLE,
        slot: 'party.registry.party.read run all',
      }),
    ).toEqual({
      capabilityKey: CAPABILITY,
      reason: 'capability_not_published',
      roleId: ROLE,
      slot: 'party.registry.party.read run all',
    });
  }),
);

it.effect('refuses a preview prepared against a release that has since moved', () =>
  Effect.gen(function* refusesMovedRelease() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    const failure = yield* problemOf(bff.preview(headers(), { ...previewPayload, catalogSnapshotId: OTHER_CATALOG }));
    expect(failure.status).toBe(409);
  }),
);

it.effect('adopts with the effect the person confirmed, under their idempotency key', () =>
  Effect.gen(function* adoptsWithNamedEffect() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    const answer = yield* bff.decide(
      headers(IDEMPOTENCY_KEY),
      decidePayload({ namedEffect: `${CAPABILITY} [read/sensitive]` }),
    );
    expect(answer.catalogSnapshotId).toBe(CATALOG);
    expect(answer.decisionIds).toEqual([DECISION]);
    expect(answer.skipped).toEqual([]);
    const [call] = commands.calls.adopt;
    expect(call?.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(call?.previewToken).toBe(FINGERPRINT);
    expect(call?.catalogSnapshotId).toBe(CATALOG);
    expect(call?.namedEffect).toBe(`${CAPABILITY} [read/sensitive]`);
    expect(commands.calls.decline).toHaveLength(0);
  }),
);

it.effect('declines without a preview token, because declining never widens access', () =>
  Effect.gen(function* declinesWithoutPreview() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    yield* bff.decide(headers(IDEMPOTENCY_KEY), {
      catalogSnapshotId: CATALOG,
      decision: 'decline',
      itemIds: [ITEM],
      legalEntityId: null,
    });
    const [call] = commands.calls.decline;
    expect(call?.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(call?.itemIds).toEqual([ITEM]);
    expect(commands.calls.adopt).toHaveLength(0);
  }),
);

it.effect('undoes the adoption under the token the person saw', () =>
  Effect.gen(function* undoesWithPreviewToken() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    yield* bff.decide(headers(IDEMPOTENCY_KEY), {
      catalogSnapshotId: CATALOG,
      decision: 'undo',
      itemIds: [ITEM],
      legalEntityId: null,
      previewToken: FINGERPRINT,
    });
    const [call] = commands.calls.undo;
    expect(call?.previewToken).toBe(FINGERPRINT);
    expect(call?.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(commands.calls.adopt).toHaveLength(0);
  }),
);

it.effect('refuses a decision without an idempotency key before anything is written', () =>
  Effect.gen(function* refusesMissingIdempotency() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    const failure = yield* problemOf(bff.decide(headers(), decidePayload()));
    expect(failure.status).toBe(422);
    expect(commands.calls.adopt).toHaveLength(0);
  }),
);

it.effect('maps every Core refusal to the one status its caller repairs it by', () =>
  Effect.gen(function* mapsCoreRefusals() {
    yield* Effect.void;
    const cases = [
      ['access_changes_preview_stale', 409],
      ['access_changes_item_unavailable', 409],
      ['access_changes_revision_stale', 409],
      ['access_changes_undo_conflict', 409],
      ['access_changes_command_conflict', 409],
      ['access_changes_command_release_missing', 409],
      ['access_changes_authority_missing', 403],
      ['access_changes_delegation_out_of_envelope', 403],
      ['access_changes_command_authority_absent', 403],
      ['access_changes_named_effect_mismatch', 422],
      ['access_changes_sensitive_requires_individual_decision', 422],
      ['access_changes_target_invalid', 422],
      ['access_changes_command_unavailable', 503],
    ] as const;
    for (const [code, status] of cases) {
      expect(accessChangesFailureProblem({ code, reason: 'unit test' }).status).toBe(status);
    }
    expect(accessChangesFailureProblem({ code: 'access_changes_command_unavailable', reason: 'x' })).toEqual(
      accessAdminUnavailableProblem(),
    );
    // A decision saved whose permissions are still being applied says exactly that, and stays retryable.
    expect(
      accessChangesFailureProblem({ code: 'access_changes_command_saved_projection_pending', reason: 'x' }),
    ).toEqual(accessAdminSavedPendingProblem());
    expect(accessAdminSavedPendingProblem()).toMatchObject({ retryable: true, status: 503 });
  }),
);

it.effect('answers a stale preview from the decision with 409, not with a write', () =>
  Effect.gen(function* answersStalePreview() {
    const commands = scriptedCommands({
      adopt: accessChangesError(
        'access_changes_preview_stale',
        'the affected holders changed since the preview was shown',
      ),
    });
    const bff = bffOf({ commands: commands.service });
    const failure = yield* problemOf(bff.decide(headers(IDEMPOTENCY_KEY), decidePayload()));
    expect(failure.status).toBe(409);
  }),
);

it.effect('never offers a routine item that widens as a one-click batch', () =>
  Effect.gen(function* neverBatchesWideningItems() {
    const wideningItem = itemView({
      id: ITEM,
      requiresIndividualDecision: false,
      risk: 'routine',
      status: 'pending',
      widens: true,
    });
    const adopted = itemView({
      id: OTHER_ITEM,
      requiresIndividualDecision: false,
      risk: 'routine',
      status: 'adopted',
      widens: false,
    });
    const commands = scriptedCommands({ read: view({ items: [wideningItem, adopted] }) });
    const bff = bffOf({ commands: commands.service });
    const answer = yield* bff.list(headers(), { limit: 10 });
    expect(commands.calls.read).toHaveLength(1);
    // Core answers the batch rule and the contract carries it: routine risk alone is never enough,
    // and a decided item is never offered — so a UI that reads only these two flags cannot bulk it.
    expect(answer.items.map(({ batchEligible }) => batchEligible)).toEqual([false, false]);
    expect(answer.items.map(({ widens }) => widens)).toEqual([true, false]);
    expect(answer.items.map(({ requiresIndividualDecision }) => requiresIndividualDecision)).toEqual([false, false]);
  }),
);

it.effect('answers every Novinky read with the published contract, field for field', () =>
  Effect.gen(function* answersThePublishedContract() {
    const commands = scriptedCommands({});
    const bff = bffOf({ commands: commands.service });
    const answer = yield* bff.list(headers(), listPayload);
    const schema = Schema.Struct({
      items: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
      nextCursor: Schema.OptionFromNullOr(Schema.String),
    });
    expect(() => decode(schema)(answer)).not.toThrow();
    const [item] = answer.items;
    expect(item?.id).toBe(ITEM);
    expect(item?.status).toBe('pending');
  }),
);
