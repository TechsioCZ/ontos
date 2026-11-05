import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Result, Schema } from 'effect';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import {
  DecideAccessChangesResponseSchema,
  ListAccessChangesResponseSchema,
  PreviewAccessChangesResponseSchema,
} from '../../shared/access-admin-api.ts';
import type {
  decideAccessChanges as actualDecideAccessChanges,
  previewAccessChanges as actualPreviewAccessChanges,
} from '../../src/api/auth-client.ts';
import {
  availableLegalEntities,
  availableTenants,
  createAccessAdministrationIdempotencyKey,
  currentSession,
  shellComposition,
} from '../../src/api/auth-client.ts' with { rstest: 'importActual' };
import { SafeTenantIdentitySchema } from '../../shared/api.ts';
import { changeItemView, liveChangesClient } from '../../src/routes/access-admin/changes/changes-bff-adapter.ts';
import { loadChangesPageModel } from '../../src/routes/[lang]/access/changes/changes-page-model.ts';
import { routeMeta } from '../../src/routes/[lang]/access/changes/route.meta.ts';
import type { AuthenticatedHomePageModel } from '../../src/routes/[lang]/home-page-model.ts';
import { ChangesClientFailure } from '../../src/routes/access-admin/changes/changes-client.ts';
import type { ChangesClient } from '../../src/routes/access-admin/changes/changes-client.ts';
import { ChangeRoleDiff } from '../../src/routes/access-admin/changes/changes-diff.tsx';
import { ChangesFeature } from '../../src/routes/access-admin/changes/changes-feature.tsx';
import {
  canConfirmPreview,
  canPreviewDecision,
  isBatchEligible,
  previewMatchesSelection,
} from '../../src/routes/access-admin/changes/changes-model.ts';
import type { ChangeItemView, ChangePreviewView } from '../../src/routes/access-admin/changes/changes-model.ts';

const { decideMock, previewMock } = rstest.hoisted(() => ({
  decideMock: rstest.fn<typeof actualDecideAccessChanges>(),
  previewMock: rstest.fn<typeof actualPreviewAccessChanges>(),
}));
rstest.mock('../../src/api/auth-client.ts', () => ({
  availableLegalEntities,
  availableTenants,
  createAccessAdministrationIdempotencyKey,
  currentSession,
  decideAccessChanges: decideMock,
  previewAccessChanges: previewMock,
  shellComposition,
}));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string, values?: { effect?: string; item?: string }) => `${key}${values?.effect ?? values?.item ?? ''}`,
  }),
}));

const routine: ChangeItemView = {
  addedCells: [],
  affectedHolders: ['Ada'],
  batchEligible: true,
  capabilityKey: 'core.shell.test.read',
  catalogSnapshotId: 'catalog-1',
  id: 'routine',
  kind: 'new',
  lineage: [],
  provenance: 'release-1',
  removedCells: [],
  risk: 'routine',
  roleNames: {},
  status: 'pending',
  suggestedRoles: ['Readers'],
  widening: false,
};
const sensitive: ChangeItemView = { ...routine, batchEligible: false, id: 'sensitive', risk: 'sensitive' };
const widening: ChangeItemView = { ...routine, id: 'widening', widening: true };
const another: ChangeItemView = { ...routine, capabilityKey: 'core.shell.other.read', id: 'another' };
const previewFor = (
  items: readonly ChangeItemView[],
  decision: ChangePreviewView['decision'] = 'adopt',
): ChangePreviewView => ({
  affectedHumanCount: 1,
  catalogSnapshotId: 'catalog-1',
  decision,
  effects: items
    .filter((item) => !isBatchEligible(item))
    .map((item) => ({ description: `Enable ${item.capabilityKey}`, itemId: item.id })),
  items,
  legalEntityId: null,
  requiresNamedEffect: items.some((item) => !isBatchEligible(item)),
  roleChanges: [],
  token: 'preview-1',
  undoSkips: [],
});
const makeClient = (items: readonly ChangeItemView[]): ChangesClient => ({
  decide: () => Effect.succeed({ legalEntityId: null, skipped: [] }),
  list: () => Effect.succeed({ items, nextCursor: null }),
  preview: (selected, decision) => Effect.succeed(previewFor(selected, decision)),
});
const show = (items: readonly ChangeItemView[], client: ChangesClient = makeClient(items), available = true) =>
  render(
    <ChangesFeature
      client={client}
      initial={{ items, nextCursor: null, writeAvailability: { available, reason: '' } }}
      initialNotice={null}
    />,
  );
const key = (suffix: string) => `shell.accessAdmin.changes.${suffix}`;

afterEach(() => {
  cleanup();
  previewMock.mockReset();
  decideMock.mockReset();
});

it.effect(
  'sends an explicit tenant target and retains the preview target echo without consulting Shell selection',
  () =>
    Effect.gen(function* bindTenantTarget() {
      const item = {
        ...routine,
        catalogSnapshotId: '10000000-0000-4000-8000-000000000001',
        id: '10000000-0000-4000-8000-000000000002',
      };
      const company = '10000000-0000-4000-8000-000000000005';
      previewMock.mockReturnValue(
        Effect.succeed(
          Schema.decodeUnknownSync(PreviewAccessChangesResponseSchema)({
            affectedAgentCount: 0,
            affectedHumanCount: 0,
            individualItemIds: [],
            items: [],
            legalEntityId: company,
            previewToken: 'preview-1',
            requiresNamedEffect: false,
            roleChanges: [],
            skipped: [],
          }),
        ),
      );
      const preview = yield* liveChangesClient.preview([item], 'adopt');
      expect(previewMock).toHaveBeenCalledWith(expect.objectContaining({ legalEntityId: null }));
      expect(preview.legalEntityId).toBe(company);
      expect(previewMatchesSelection(preview, [item], 'adopt')).toBe(false);
      const refused = yield* Effect.result(liveChangesClient.decide(preview, 'tenant-command'));
      expect(Result.isFailure(refused)).toBe(true);
      expect(decideMock).not.toHaveBeenCalled();
    }),
);

it.effect('binds adopt, decline and undo commands to null and retains their receipt target echo', () =>
  Effect.gen(function* bindDecisionTargets() {
    const catalogSnapshotId = '10000000-0000-4000-8000-000000000001';
    const item = { ...routine, catalogSnapshotId, id: '10000000-0000-4000-8000-000000000002' };
    decideMock.mockReturnValue(
      Effect.succeed(
        Schema.decodeUnknownSync(DecideAccessChangesResponseSchema)({
          catalogSnapshotId,
          decisionIds: [],
          legalEntityId: null,
          skipped: [],
        }),
      ),
    );
    for (const decision of ['adopt', 'decline', 'undo'] as const) {
      const receipt = yield* liveChangesClient.decide(
        { ...previewFor([item], decision), catalogSnapshotId },
        'tenant-command',
      );
      expect(receipt.legalEntityId).toBeNull();
      expect(decideMock).toHaveBeenLastCalledWith(expect.objectContaining({ decision, legalEntityId: null }), {
        idempotencyKey: 'tenant-command',
      });
    }
  }),
);

it('declares a private, non-indexable tenant system page with its own protected capability', () => {
  expect(routeMeta.public).toBe(false);
  expect(routeMeta.indexable).toBe(false);
  expect(routeMeta.entrypoint.authorization.kind).toBe('protected');
  expect(routeMeta.entrypoint.moduleKey).toBe('shell-super-app');
  expect(routeMeta.accessDeclaration.key).toBe('shell-super-app.access-changes.page');
});

it('renders exact role revisions and before/after cells without claiming one revision per item', () => {
  render(
    <ChangeRoleDiff
      changes={[
        {
          after: [
            {
              amountCeiling: { currency: 'CZK', limitMinor: 12_500 },
              capabilityKey: 'core.shell.after.read',
              mode: 'run',
              selector: { _tag: 'all' },
            },
          ],
          before: [{ capabilityKey: 'core.shell.before.read', mode: 'propose', selector: { _tag: 'assigned' } }],
          expectedRevisionId: 'revision-1',
          roleId: 'role-1',
          roleName: 'Readers',
        },
      ]}
    />,
  );
  expect(screen.getByText('revision-1')).toBeTruthy();
  expect(screen.getByText('core.shell.before.read')).toBeTruthy();
  expect(screen.getByText('core.shell.after.read')).toBeTruthy();
  expect(screen.getByText('shell.accessAdmin.mode.propose')).toBeTruthy();
  expect(screen.getByText('shell.accessAdmin.role.scopeAssigned')).toBeTruthy();
  expect(screen.getByText(key('amountCeiling'))).toBeTruthy();
  cleanup();
  render(<ChangeRoleDiff changes={[]} />);
  expect(screen.getByText(key('noRoleChanges'))).toBeTruthy();
});

it('batches only explicitly eligible, non-widening routine pending items from the same release', () => {
  expect(canPreviewDecision([routine, another], 'adopt')).toBe(true);
  for (const unsafe of [
    sensitive,
    widening,
    { ...routine, widening: null },
    { ...routine, batchEligible: false },
    { ...routine, risk: 'critical' as const },
    { ...routine, catalogSnapshotId: 'other' },
  ]) {
    expect(canPreviewDecision([routine, unsafe], 'adopt')).toBe(false);
  }
  expect(canPreviewDecision([routine, another], 'decline')).toBe(false);
  expect(canPreviewDecision([routine, routine], 'adopt')).toBe(false);
  expect(canPreviewDecision([], 'adopt')).toBe(false);
});

it('uses authoritative widening and batch eligibility, not P1 risk-only classification', () => {
  const response = Schema.decodeUnknownSync(ListAccessChangesResponseSchema)({
    catalogSnapshotId: '10000000-0000-4000-8000-000000000001',
    items: [
      {
        addedCells: [],
        affectedAgentCount: 0,
        affectedHumanCount: 0,
        batchEligible: false,
        capabilityKey: 'core.shell.test.read',
        catalogSnapshotId: '10000000-0000-4000-8000-000000000001',
        holders: [],
        id: '10000000-0000-4000-8000-000000000002',
        kind: 'new',
        lineageFrom: [],
        removedCells: [],
        requiresIndividualDecision: false,
        risk: 'routine',
        status: 'pending',
        suggestedRoleIds: [],
        widens: true,
      },
    ],
    nextCursor: null,
    roles: [],
    writeAvailability: { available: false, reason: 'pending real-gate verification' },
  });
  for (const item of response.items) {
    const view = changeItemView(item, response.roles);
    expect(view.widening).toBe(true);
    expect(isBatchEligible(view)).toBe(false);
    expect(view.addedCells).toEqual([]);
    expect(view.removedCells).toEqual([]);
    expect(isBatchEligible(changeItemView({ ...item, batchEligible: true, widens: false }, response.roles))).toBe(true);
  }
});

it('refuses terminal undone items and permits only a single adopted item for undo', () => {
  const undone = { ...routine, status: 'undone' as const };
  for (const decision of ['adopt', 'decline', 'undo'] as const) {
    expect(canPreviewDecision([undone], decision)).toBe(false);
  }
  expect(canPreviewDecision([{ ...routine, status: 'adopted' }], 'undo')).toBe(true);
  expect(canPreviewDecision([routine], 'undo')).toBe(false);
});

it('requires a fresh, selection-bound preview and a named effect for an individual dangerous change', () => {
  const preview = previewFor([sensitive]);
  expect(canConfirmPreview(preview, [])).toBe(false);
  expect(canConfirmPreview(preview, [sensitive.id])).toBe(true);
  expect(canConfirmPreview({ ...preview, effects: [] }, [sensitive.id])).toBe(false);
  expect(canConfirmPreview({ ...preview, token: '' }, [sensitive.id])).toBe(false);
  expect(previewMatchesSelection(preview, [sensitive], 'adopt')).toBe(true);
  const companyEcho = { ...preview, legalEntityId: '10000000-0000-4000-8000-000000000005' };
  expect(previewMatchesSelection(companyEcho, [sensitive], 'adopt')).toBe(false);
  expect(canConfirmPreview(companyEcho, [sensitive.id])).toBe(false);
  expect(previewMatchesSelection(preview, [sensitive], 'decline')).toBe(false);
  expect(previewMatchesSelection(preview, [routine], 'adopt')).toBe(false);
  expect(previewMatchesSelection({ ...preview, catalogSnapshotId: 'old' }, [sensitive], 'adopt')).toBe(false);
});

it('offers no bulk selection for sensitive, critical, widening or undone items', () => {
  show([
    routine,
    sensitive,
    widening,
    { ...routine, id: 'critical', risk: 'critical' },
    { ...routine, id: 'undone', status: 'undone' },
  ]);
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByText(key('wideningWarning'))).toBeTruthy();
  expect(screen.getByText(key('undoneTerminal'))).toBeTruthy();
  expect(screen.queryByRole('button', { name: key('adopt') })).toBeNull();
});

it.effect('requires preview then explicit named confirmation before the write, never one click', () =>
  Effect.gen(function* confirmNamedEffect() {
    const user = userEvent.setup();
    const decide = rstest.fn(() => Effect.succeed({ legalEntityId: null, skipped: [] }));
    show([sensitive], { ...makeClient([sensitive]), decide });
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewAdopt') })));
    expect(decide).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: key('adopt') });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    yield* Effect.promise(() => user.click(screen.getByRole('checkbox')));
    expect(confirm.hasAttribute('disabled')).toBe(false);
    yield* Effect.promise(() => user.click(confirm));
    yield* Effect.promise(() => waitFor(() => expect(decide).toHaveBeenCalledTimes(1)));
    expect(screen.queryByRole('button', { name: key('adopt') })).toBeNull();
  }),
);

it.effect('invalidates a routine preview when the selection changes', () =>
  Effect.gen(function* invalidateSelection() {
    const user = userEvent.setup();
    const decide = rstest.fn(() => Effect.succeed({ legalEntityId: null, skipped: [] }));
    show([routine, another], { ...makeClient([routine, another]), decide });
    yield* Effect.promise(() =>
      user.click(screen.getByRole('checkbox', { name: `${key('selectItem')}${routine.capabilityKey}` })),
    );
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewBatch') })));
    expect(screen.getByRole('button', { name: key('adopt') })).toBeTruthy();
    yield* Effect.promise(() =>
      user.click(screen.getByRole('checkbox', { name: `${key('selectItem')}${another.capabilityKey}` })),
    );
    expect(screen.queryByRole('button', { name: key('adopt') })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  }),
);

it.effect('discards a stale preview on 409 and requires refresh/review rather than retrying the write', () =>
  Effect.gen(function* refreshStalePreview() {
    const user = userEvent.setup();
    const decide = rstest.fn(() => Effect.fail(new ChangesClientFailure({ reason: 'stalePreview' })));
    const list = rstest.fn(() => Effect.succeed({ items: [routine], nextCursor: null }));
    show([routine], { ...makeClient([routine]), decide, list });
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewAdopt') })));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('adopt') })));
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('shell.accessAdmin.common.stalePreview')).toBeTruthy()),
    );
    expect(screen.queryByRole('button', { name: key('adopt') })).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: key('previewAdopt') }).hasAttribute('disabled')).toBe(true);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'shell.accessAdmin.common.refresh' })));
    expect(list).toHaveBeenCalledTimes(1);
  }),
);

it.effect('shows undo skips and the no-revocation-restore explanation before confirmation', () =>
  Effect.gen(function* previewUndoSkips() {
    const user = userEvent.setup();
    const adopted = { ...routine, status: 'adopted' as const };
    show([adopted], {
      ...makeClient([adopted]),
      preview: (items, decision) =>
        Effect.succeed({
          ...previewFor(items, decision),
          undoSkips: [
            {
              capabilityKey: routine.capabilityKey,
              reason: 'cell_revoked_later' as const,
              roleId: 'role-1',
              slot: 'all',
            },
          ],
        }),
    });
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewUndo') })));
    expect(screen.getByText(key('undoHelp'))).toBeTruthy();
    expect(screen.getByText(key('noRevocationRestore'))).toBeTruthy();
    expect(screen.getByText(`${key('undoSkippedItem')}${routine.capabilityKey}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: key('undo') }).hasAttribute('disabled')).toBe(true);
  }),
);

it.effect('does not claim that unknown undo skips are empty and displays returned skips after commit', () =>
  Effect.gen(function* undoReceiptSkips() {
    const user = userEvent.setup();
    const adopted = { ...routine, status: 'adopted' as const };
    const client: ChangesClient = {
      ...makeClient([adopted]),
      decide: () =>
        Effect.succeed({
          legalEntityId: null,
          skipped: [
            { capabilityKey: routine.capabilityKey, reason: 'cell_revoked_later', roleId: 'role-1', slot: 'all' },
          ],
        }),
      preview: (items, decision) => Effect.succeed({ ...previewFor(items, decision), undoSkips: null }),
    };
    show([adopted], client);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewUndo') })));
    expect(screen.getByRole('button', { name: key('undo') }).hasAttribute('disabled')).toBe(true);
    yield* Effect.promise(() => user.click(screen.getByRole('checkbox')));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('undo') })));
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText(`${key('undoSkippedItem')}${routine.capabilityKey}`)).toBeTruthy()),
    );
    expect(screen.queryByText('cell_revoked_later')).toBeNull();
  }),
);

it.effect('decline remains an explicit two-step decision and never adopts an item', () =>
  Effect.gen(function* declineItem() {
    const user = userEvent.setup();
    const decide = rstest.fn(() => Effect.succeed({ legalEntityId: null, skipped: [] }));
    show([sensitive], { ...makeClient([sensitive]), decide });
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewDecline') })));
    expect(decide).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: key('adopt') })).toBeNull();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('decline') })));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'decline' }), expect.any(String));
  }),
);

it.effect('keeps the server-closed writer disabled while allowing read-only previews', () =>
  Effect.gen(function* previewWithClosedWriter() {
    const user = userEvent.setup();
    const decide = rstest.fn(() => Effect.succeed({ legalEntityId: null, skipped: [] }));
    show([routine], { ...makeClient([routine]), decide }, false);
    expect(screen.getByText(key('writesUnavailable'))).toBeTruthy();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewAdopt') })));
    expect(screen.getByRole('button', { name: key('adopt') }).hasAttribute('disabled')).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  }),
);

it.effect('enables decisions only after a refreshed server availability allows them', () =>
  Effect.gen(function* observeServerAvailability() {
    const user = userEvent.setup();
    const client: ChangesClient = {
      ...makeClient([routine]),
      list: () =>
        Effect.succeed({ items: [routine], nextCursor: null, writeAvailability: { available: true, reason: '' } }),
    };
    show([routine], client, false);
    expect(screen.getByText(key('writesUnavailable'))).toBeTruthy();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'shell.accessAdmin.common.refresh' })));
    expect(screen.queryByText(key('writesUnavailable'))).toBeNull();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewAdopt') })));
    expect(screen.getByRole('button', { name: key('adopt') }).hasAttribute('disabled')).toBe(false);
  }),
);

it.effect('retains the selected items when the write gate becomes unavailable, without retrying the write', () =>
  Effect.gen(function* preserveUnavailableSelection() {
    const user = userEvent.setup();
    const decide = rstest.fn(() => Effect.fail(new ChangesClientFailure({ reason: 'unavailable' })));
    show([routine], { ...makeClient([routine]), decide });
    yield* Effect.promise(() => user.click(screen.getByRole('checkbox')));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('previewBatch') })));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: key('adopt') })));
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('shell.accessAdmin.common.unavailable')).toBeTruthy()),
    );
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    expect(screen.queryByRole('button', { name: key('adopt') })).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
  }),
);

const tenantShell: AuthenticatedHomePageModel = {
  contextState: 'selection_required',
  identity: Schema.decodeUnknownSync(SafeTenantIdentitySchema)({
    displayName: 'Ada',
    email: 'ada@example.test',
    principalId: '10000000-0000-4000-8000-000000000003',
    tenantId: '10000000-0000-4000-8000-000000000004',
  }),
  legalEntities: { items: [], state: 'available' },
  navigation: { items: [], state: 'available', unavailableDeployments: [] },
  state: 'authenticated',
  tenants: { items: [], state: 'available' },
};

it.effect('loads tenant administration without requiring a selected company', () =>
  Effect.gen(function* loadTenantAdmin() {
    const list = rstest.fn(() => Effect.succeed({ items: [routine], nextCursor: null }));
    const model = yield* loadChangesPageModel(tenantShell, { ...makeClient([routine]), list });
    expect(list).toHaveBeenCalledTimes(1);
    expect(model.list.items).toHaveLength(1);
    expect(model.notice).toBeNull();
  }),
);

it.effect('does not query protected data for anonymous sessions and distinguishes 403 from 503', () =>
  Effect.gen(function* refuseAnonymous() {
    const list = rstest.fn(() => Effect.succeed({ items: [routine], nextCursor: null }));
    const anonymous = yield* loadChangesPageModel({ state: 'anonymous' }, { ...makeClient([routine]), list });
    expect(anonymous.notice).toBe('unauthenticated');
    expect(list).not.toHaveBeenCalled();
    for (const reason of ['forbidden', 'unavailable'] as const) {
      const model = yield* loadChangesPageModel(tenantShell, {
        ...makeClient([routine]),
        list: () => Effect.fail(new ChangesClientFailure({ reason })),
      });
      expect(model.notice).toBe(reason);
      expect(model.list.items).toEqual([]);
    }
  }),
);
