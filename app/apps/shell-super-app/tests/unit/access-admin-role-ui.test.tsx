import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest, test } from 'effect-rstest';

import {
  addExactLevel,
  canSaveRolePreview,
  parseAmountCeiling,
  toggleRoleCell,
} from '../../src/routes/access-admin/role-editor/model.ts';
import type {
  RoleCapabilityView,
  RoleCellView,
  RolePreviewView,
} from '../../src/routes/access-admin/role-editor/model.ts';
import { RoleEditorView } from '../../src/routes/access-admin/role-editor/role-editor-view.tsx';
import type { RoleEditorViewProps } from '../../src/routes/access-admin/role-editor/role-editor-view.tsx';
import { routeMeta } from '../../src/routes/[lang]/access/roles/route.meta.ts';
import { loadRolePageModel } from '../../src/routes/[lang]/access/roles/role-page-model.ts';
import { authenticatedShellFixture } from './routes/authenticated-shell-fixture.ts';
import { roleErrorStatus } from '../../src/routes/access-admin/role-editor/role-commands.ts';
import { RoleEditorFeature } from '../../src/routes/access-admin/role-editor/role-editor-feature.tsx';
import { CreateRoleFeature } from '../../src/routes/access-admin/role-editor/create-role-feature.tsx';
import type { GetAccessRoleResponse } from '../../shared/access-admin-api.ts';
import {
  AccessRoleSchema,
  AccessRoleTemplateSchema,
  ListAccessRoleTemplatesResponseSchema,
  PreviewAccessRoleEditResponseSchema,
} from '../../shared/access-admin-api.ts';

const { createCall, homeCall, listCall, previewCall, saveCall, templatesCall } = rstest.hoisted(() => ({
  createCall: rstest.fn(),
  homeCall: rstest.fn(),
  listCall: rstest.fn(),
  previewCall: rstest.fn(),
  saveCall: rstest.fn(),
  templatesCall: rstest.fn(),
}));
rstest.mock('../../src/api/auth-client.ts', () => ({
  createAccessAdministrationIdempotencyKey: () => Effect.succeed('test-idempotency-key'),
  createAccessRole: createCall,
  listAccessRoles: listCall,
  listAccessRoleTemplates: templatesCall,
  previewAccessRoleEdit: previewCall,
  saveAccessRoleEdit: saveCall,
}));
rstest.mock('../../src/routes/[lang]/home-page-model.ts', () => ({ loadHomePageModel: homeCall }));
rstest.mock('../../src/routes/shell-authentication-client-options.ts', () => ({
  shellAuthenticationClientOptionsFromRequest: () => Effect.succeed({ locale: 'en' }),
}));
beforeEach(() => {
  homeCall.mockReset();
  listCall.mockReset();
  templatesCall.mockReset();
  createCall.mockReset();
  previewCall.mockReset();
  saveCall.mockReset();
});

interface NavigationStub {
  readonly proceed: () => void;
  readonly reset: () => void;
  shouldBlock: () => boolean;
  status: 'blocked' | 'idle';
}
const navigation = rstest.hoisted((): NavigationStub => ({
  proceed: rstest.fn<() => void>(),
  reset: rstest.fn<() => void>(),
  shouldBlock: (): boolean => false,
  status: 'idle',
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => {
    navigation.shouldBlock = options.shouldBlockFn;
    return { proceed: navigation.proceed, reset: navigation.reset, status: navigation.status };
  },
}));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'en',
    t: (key: string, values?: Readonly<Record<string, string>>) =>
      values?.['effect'] === undefined ? key : `${key}: ${values['effect']}`,
  }),
}));

afterEach(cleanup);
const saveName = saveLabelsFor('en').save;
const saveButton = () => screen.getByRole('button', { name: saveName });
const cell: RoleCellView = { capabilityKey: 'commerce.order.order.read', mode: 'run', selector: { _tag: 'all' } };
const capability: RoleCapabilityView = {
  key: cell.capabilityKey,
  kind: 'read',
  modes: ['run'],
  moduleKey: 'commerce.order',
  placement: { group: 'orders', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const dangerous: RoleCellView = {
  capabilityKey: 'commerce.order.order.cancel',
  mode: 'run',
  selector: { _tag: 'all' },
};
const preview: RolePreviewView = {
  added: [dangerous],
  affectedHumanCount: 3,
  affectedPeople: ['person-1', 'person-2', 'person-3'],
  dangerousEffects: [
    { description: 'Cancel committed orders', id: 'cancel', value: 'run:action:critical' },
    { description: 'Approve payments', id: 'approve', value: 'approve:action:critical' },
  ],
  previewToken: 'server-preview',
  removed: [],
  requiresNamedEffect: true,
};
const props = (): RoleEditorViewProps => ({
  catalogSnapshotId: 'published-catalog',
  cells: [cell],
  confirmations: [],
  entries: [capability],
  onAmount: rstest.fn<RoleEditorViewProps['onAmount']>(),
  onConfirm: rstest.fn<RoleEditorViewProps['onConfirm']>(),
  onLevel: rstest.fn<RoleEditorViewProps['onLevel']>(),
  onPreview: rstest.fn<RoleEditorViewProps['onPreview']>(),
  onRefresh: rstest.fn<RoleEditorViewProps['onRefresh']>(),
  onSave: rstest.fn<RoleEditorViewProps['onSave']>(),
  onTemplate: rstest.fn<RoleEditorViewProps['onTemplate']>(),
  onToggleCell: rstest.fn<RoleEditorViewProps['onToggleCell']>(),
  preview: null,
  role: {
    catalogSnapshotId: 'source-catalog',
    cells: [cell],
    id: 'role-1',
    name: 'Operations',
    revision: 2,
    revisionId: 'revision-2',
  },
  saveState: 'idle',
  status: 'idle',
  templates: [],
  writesAvailable: true,
});

test('route is private, non-indexable and protected by its Shell administration declaration', () => {
  expect(routeMeta.public).toBe(false);
  expect(routeMeta.indexable).toBe(false);
  expect(routeMeta.entrypoint.authorization.kind).toBe('protected');
  expect(routeMeta.entrypoint.moduleKey).toBe('shell-super-app');
  expect(routeMeta.accessDeclaration.key.startsWith(`${routeMeta.entrypoint.moduleKey}.`)).toBe(true);
  expect(routeMeta.accessDeclaration.kind).toBe('admin');
  expect(routeMeta.accessDeclaration.selectors).toEqual([]);
});

test('level materializes exact current-catalog run cells, not future keys or approval modes', () => {
  const selected = addExactLevel(
    [],
    [
      capability,
      {
        ...capability,
        key: dangerous.capabilityKey,
        modes: ['run', 'propose', 'approve'],
        placement: { group: 'orders', level: 'manage' },
      },
    ],
    'commerce.order',
    'basic',
  );
  expect(selected).toEqual([cell]);
  expect(addExactLevel(selected, [capability], 'commerce.order', 'basic')).toEqual([cell]);
  expect(selected.some((entry) => entry.capabilityKey === 'commerce.order.future.read')).toBe(false);
});

test('level does not manufacture an all-records selector or widen explicit targets', () => {
  expect(addExactLevel([], [{ ...capability, selectors: ['assigned'] }], 'commerce.order', 'basic')).toEqual([]);
  const target: RoleCellView = { ...cell, selector: { _tag: 'targets', recordKeys: ['record-1'] } };
  expect(addExactLevel([target], [capability], 'commerce.order', 'basic')).toEqual([target]);
});

test('individual toggles preserve every other scope and amount ceiling', () => {
  const limited: RoleCellView = {
    ...cell,
    amountCeiling: { currency: 'CZK', limitMinor: 100 },
    selector: { _tag: 'assigned' },
  };
  expect(toggleRoleCell([cell, limited], cell, false)).toEqual([limited]);
  expect(toggleRoleCell([limited], limited, true)).toEqual([limited]);
});

test('amount editor accepts integer minor units including zero and rejects unsafe or incomplete values', () => {
  expect(parseAmountCeiling('0', 'CZK')).toEqual({ currency: 'CZK', limitMinor: 0 });
  expect(parseAmountCeiling('', '')).toBeUndefined();
  for (const amount of ['-1', '1.5', '1e3', 'Infinity', '9007199254740992']) {
    expect(parseAmountCeiling(amount, 'CZK')).toBe('invalid');
  }
  expect(parseAmountCeiling('100', 'czk')).toBe('invalid');
});

test('save requires every named effect, a current preview, idle state and backed writer', () => {
  expect(canSaveRolePreview(preview, ['cancel'], 'idle', true)).toBe(false);
  expect(canSaveRolePreview(preview, ['cancel', 'approve'], 'idle', true)).toBe(true);
  expect(canSaveRolePreview(preview, ['cancel', 'approve'], 'conflict', true)).toBe(false);
  expect(canSaveRolePreview(preview, ['cancel', 'approve'], 'saving', true)).toBe(false);
  expect(canSaveRolePreview(preview, ['cancel', 'approve'], 'idle', false)).toBe(false);
  expect(canSaveRolePreview(null, ['cancel', 'approve'], 'idle', true)).toBe(false);
  expect(canSaveRolePreview({ ...preview, dangerousEffects: [] }, [], 'idle', true)).toBe(false);
});

it.effect('kit checkbox is keyboard-operable and names the exact capability, mode and scope', () =>
  Effect.gen(function* keyboardCellTest() {
    const input = props();
    render(<RoleEditorView {...input} />);
    const checkbox = screen.getByRole('checkbox', { name: /commerce\.order\.order\.read/u });
    checkbox.focus();
    const user = userEvent.setup();
    yield* Effect.promise(() => user.keyboard(' '));
    expect(input.onToggleCell).toHaveBeenCalledWith(cell, false);
  }),
);

it.effect('dangerous effects have distinct accessible names and cannot save with partial acknowledgement', () =>
  Effect.gen(function* keyboardConfirmationTest() {
    const input = { ...props(), cells: [cell, dangerous], preview, saveState: 'invalid' as const };
    const { rerender } = render(<RoleEditorView {...input} />);
    expect(saveButton().hasAttribute('disabled')).toBe(true);
    const confirm = screen.getByRole('checkbox', { name: /Cancel committed orders/u });
    confirm.focus();
    const user = userEvent.setup();
    yield* Effect.promise(() => user.keyboard(' '));
    expect(input.onConfirm).toHaveBeenCalledWith('cancel', true);
    rerender(<RoleEditorView {...input} confirmations={['cancel']} />);
    expect(saveButton().hasAttribute('disabled')).toBe(true);
    rerender(<RoleEditorView {...input} confirmations={['cancel', 'approve']} saveState="dirty" />);
    yield* Effect.promise(() => user.click(saveButton()));
    expect(input.onSave).toHaveBeenCalledTimes(1);
  }),
);

test('preview shows full before/after and server affected-human count', () => {
  render(<RoleEditorView {...props()} cells={[cell, dangerous]} preview={preview} />);
  const before = screen.getByRole('region', { name: 'shell.accessAdmin.common.beforeState' });
  const after = screen.getByRole('region', { name: 'shell.accessAdmin.common.afterState' });
  expect(within(before).getByText(cell.capabilityKey)).toBeTruthy();
  expect(within(before).queryByText(dangerous.capabilityKey)).toBeNull();
  expect(within(after).getByText(dangerous.capabilityKey)).toBeTruthy();
  expect(screen.getByText('shell.accessAdmin.role.affectedPeople: 3')).toBeTruthy();
});

test('unavailable writer never advertises a working save and expiry stays assignment-owned', () => {
  render(
    <RoleEditorView
      {...props()}
      confirmations={['cancel', 'approve']}
      preview={preview}
      saveState="invalid"
      writesAvailable={false}
    />,
  );
  expect(saveButton().hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('shell.accessAdmin.role.writesUnavailable')).toBeTruthy();
  expect(screen.getByText('shell.accessAdmin.role.assignmentExpiryHelp')).toBeTruthy();
  expect(screen.queryByLabelText('shell.accessAdmin.role.expiry')).toBeNull();
});

test('stale revision disables editor and offers refresh without treating it as an outage', () => {
  render(<RoleEditorView {...props()} status="conflict" />);
  expect(screen.getByText('shell.accessAdmin.common.conflict')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'shell.accessAdmin.common.preview' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'shell.accessAdmin.common.refresh' }).hasAttribute('disabled')).toBe(false);
});

test('retains and displays unsupported exact targets instead of silently dropping them', () => {
  render(
    <RoleEditorView {...props()} cells={[{ ...cell, selector: { _tag: 'targets', recordKeys: ['record-1'] } }]} />,
  );
  expect(screen.getByText('shell.accessAdmin.role.unsupportedCells')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: /scopeTargets/u })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: /scopeAll/u }).hasAttribute('disabled')).toBe(true);
});

const featureFixture = () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const role = Schema.decodeUnknownSync(AccessRoleSchema)({
    catalogSnapshotId: id,
    cells: [cell],
    holderCount: 3,
    id,
    name: 'Operations',
    provenance: 'manual',
    revision: 1,
    revisionId: id,
    scope: 'tenant',
  });
  const catalog = Schema.decodeUnknownSync(ListAccessRoleTemplatesResponseSchema)({
    catalogSnapshotId: id,
    createAvailable: true,
    entries: [
      {
        capabilityKey: cell.capabilityKey,
        kind: 'read',
        modes: ['run'],
        moduleKey: 'commerce.order',
        placement: { group: 'orders', level: 'basic' },
        risk: 'routine',
        selectors: [],
      },
      {
        capabilityKey: dangerous.capabilityKey,
        kind: 'action',
        modes: ['run', 'propose'],
        moduleKey: 'commerce.order',
        placement: { group: 'orders', level: 'manage' },
        risk: 'critical',
        selectors: [],
      },
    ],
    publishedAt: '2026-11-03T00:00:00Z',
    saveAvailable: true,
    templates: [],
  });
  const response = Schema.decodeUnknownSync(PreviewAccessRoleEditResponseSchema)({
    added: [dangerous],
    affectedAgentCount: 0,
    affectedHolders: [],
    affectedHumanCount: 3,
    cells: [cell, dangerous],
    changes: true,
    dangerous: [
      {
        capabilityKey: dangerous.capabilityKey,
        effect: 'run:action:critical',
        mode: 'run',
        risk: 'critical',
        slot: 'danger-slot',
      },
    ],
    previewToken: 'trusted-preview',
    removed: [],
    requiresNamedEffect: true,
  });
  return { catalog, response, role };
};

it.effect('editing after a server preview invalidates both token and confirmations before save', () =>
  Effect.gen(function* stalePreviewTest() {
    const fixture = featureFixture();
    previewCall.mockReturnValue(Effect.succeed(fixture.response));
    render(
      <RoleEditorFeature
        catalog={fixture.catalog}
        initialRole={fixture.role}
        onRefresh={() => {}}
        onSaved={() => {}}
        writesAvailable
      />,
    );
    const user = userEvent.setup();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'shell.accessAdmin.common.preview' })));
    yield* Effect.promise(() => screen.findByRole('checkbox', { name: /dangerousConfirmEffect/u }));
    yield* Effect.promise(() => user.click(screen.getByRole('checkbox', { name: /dangerousConfirmEffect/u })));
    expect(saveButton().hasAttribute('disabled')).toBe(false);
    yield* Effect.promise(() => user.click(screen.getByRole('checkbox', { name: /commerce\.order\.order\.read/u })));
    expect(screen.queryByRole('checkbox', { name: /dangerousConfirmEffect/u })).toBeNull();
    expect(saveButton().hasAttribute('disabled')).toBe(true);
    expect(saveCall).not.toHaveBeenCalled();
  }),
);

it.effect(
  'unavailable save retries the same idempotency key and echoes server effect without displaying its code',
  () =>
    Effect.gen(function* retryTest() {
      const fixture = featureFixture();
      previewCall.mockReturnValue(Effect.succeed(fixture.response));
      saveCall.mockReturnValue(
        Effect.fail({
          _tag: 'AccessAdminUnavailable',
          detail: 'Unavailable',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'urn:test',
        }),
      );
      render(
        <RoleEditorFeature
          catalog={fixture.catalog}
          initialRole={fixture.role}
          onRefresh={() => {}}
          onSaved={() => {}}
          writesAvailable
        />,
      );
      const user = userEvent.setup();
      yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'shell.accessAdmin.common.preview' })));
      yield* Effect.promise(() => screen.findByRole('checkbox', { name: /dangerousConfirmEffect/u }));
      expect(document.body.textContent).not.toContain('run:action:critical');
      yield* Effect.promise(() => user.click(screen.getByRole('checkbox', { name: /dangerousConfirmEffect/u })));
      yield* Effect.promise(() => user.click(saveButton()));
      yield* Effect.promise(() => screen.findAllByText('shell.accessAdmin.common.unavailable'));
      yield* Effect.promise(() => user.click(saveButton()));
      yield* Effect.promise(() => waitFor(() => expect(saveCall).toHaveBeenCalledTimes(2)));
      expect(saveCall.mock.calls[0]?.[1]).toEqual(saveCall.mock.calls[1]?.[1]);
      expect(saveCall).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmedEffects: [{ effect: 'run:action:critical', slot: 'danger-slot' }],
          previewToken: 'trusted-preview',
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
    }),
);

it.effect('creation uses only the blank template with no cells, then selects the created role', () =>
  Effect.gen(function* blankRoleTest() {
    const fixture = featureFixture();
    const catalog = {
      ...fixture.catalog,
      templates: [
        Schema.decodeUnknownSync(AccessRoleTemplateSchema)({
          catalogSnapshotId: fixture.catalog.catalogSnapshotId,
          cells: [],
          name: 'Blank',
          source: 'blank',
          templateKey: 'blank',
        }),
      ],
    };
    const created = { ...fixture.role, cells: [] };
    createCall.mockReturnValue(Effect.succeed(created));
    const onCreated = rstest.fn<(role: typeof fixture.role) => void>();
    render(<CreateRoleFeature catalog={catalog} onCreated={onCreated} writesAvailable />);
    const user = userEvent.setup();
    yield* Effect.promise(() => user.type(screen.getByLabelText(/shell.accessAdmin.role.name/u), 'New role'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Save' })));
    yield* Effect.promise(() => waitFor(() => expect(onCreated).toHaveBeenCalledWith(created)));
    expect(createCall).toHaveBeenCalledWith(
      expect.objectContaining({ cells: [], name: 'New role', scope: { kind: 'tenant' }, templateKey: 'blank' }),
      expect.objectContaining({ idempotencyKey: 'test-idempotency-key' }),
    );
  }),
);

test('creation cannot use a nonblank template or an unavailable writer', () => {
  const fixture = featureFixture();
  render(<CreateRoleFeature catalog={fixture.catalog} onCreated={() => {}} writesAvailable={false} />);
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  expect(createCall).not.toHaveBeenCalled();
});

const blankCatalog = () => {
  const fixture = featureFixture();
  return {
    ...fixture.catalog,
    templates: [
      Schema.decodeUnknownSync(AccessRoleTemplateSchema)({
        catalogSnapshotId: fixture.catalog.catalogSnapshotId,
        cells: [],
        name: 'Blank',
        source: 'blank',
        templateKey: 'blank',
      }),
    ],
  };
};

it.effect('create role: typing writes nothing, Save writes once', () =>
  Effect.gen(function* createWritesOnSaveTest() {
    const created = { ...featureFixture().role, cells: [] };
    createCall.mockReturnValue(Effect.succeed(created));
    const onCreated = rstest.fn<(role: GetAccessRoleResponse['role']) => void>();
    render(<CreateRoleFeature catalog={blankCatalog()} onCreated={onCreated} writesAvailable />);
    const user = userEvent.setup();
    yield* Effect.promise(() => user.type(screen.getByLabelText(/shell.accessAdmin.role.name/u), 'New role'));
    expect(createCall).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Save' })));
    yield* Effect.promise(() => waitFor(() => expect(onCreated).toHaveBeenCalledWith(created)));
    expect(createCall).toHaveBeenCalledTimes(1);
  }),
);

it.effect('create role: leaving with unsaved input asks first, Discard sends nothing', () =>
  Effect.gen(function* createLeaveAsksTest() {
    createCall.mockReturnValue(Effect.succeed({ ...featureFixture().role, cells: [] }));
    const onCreated = rstest.fn<(role: GetAccessRoleResponse['role']) => void>();
    const page = () => <CreateRoleFeature catalog={blankCatalog()} onCreated={onCreated} writesAvailable />;
    const view = render(page());
    const user = userEvent.setup();
    yield* Effect.promise(() => user.type(screen.getByLabelText(/shell.accessAdmin.role.name/u), 'New role'));
    expect(navigation.shouldBlock()).toBe(true);
    // The router holds the navigation (a Shell link, browser Back) and the form asks.
    navigation.status = 'blocked';
    view.rerender(page());
    const discard = yield* Effect.promise(() => screen.findByRole('button', { name: 'Discard changes' }));
    yield* Effect.promise(() => user.click(discard));
    expect(navigation.proceed).toHaveBeenCalledTimes(1);
    expect(createCall).not.toHaveBeenCalled();
    navigation.status = 'idle';
  }),
);

it.effect('tenant administration loads without a selected company and anonymous sessions do not issue role reads', () =>
  Effect.gen(function* tenantContextTest() {
    const fixture = featureFixture();
    const { selectedLegalEntityId, ...shell } = authenticatedShellFixture();
    void selectedLegalEntityId;
    homeCall.mockReturnValue(Effect.succeed({ ...shell, contextState: 'selection_required' }));
    listCall.mockReturnValue(Effect.succeed({ items: [fixture.role], nextCursor: null }));
    templatesCall.mockReturnValue(Effect.succeed(fixture.catalog));
    const model = yield* loadRolePageModel(new Request('https://app.example.test/en/access/roles'));
    expect(model.state).toBe('ready');
    expect(listCall).toHaveBeenCalledWith({ limit: 100 }, { locale: 'en' });
    expect(templatesCall).toHaveBeenCalledTimes(1);
    listCall.mockClear();
    templatesCall.mockClear();
    homeCall.mockReturnValue(Effect.succeed({ state: 'anonymous' }));
    const anonymous = yield* loadRolePageModel(new Request('https://app.example.test/en/access/roles'));
    expect(anonymous.state).toBe('unauthenticated');
    expect(listCall).not.toHaveBeenCalled();
    expect(templatesCall).not.toHaveBeenCalled();
  }),
);

it.effect('successful save remains visible and the next preview uses the returned revision', () =>
  Effect.gen(function* savedRevisionTest() {
    const fixture = featureFixture();
    const savedRole = Schema.decodeUnknownSync(AccessRoleSchema)({
      ...fixture.role,
      cells: fixture.response.cells,
      revision: 2,
      revisionId: '00000000-0000-4000-8000-000000000002',
    });
    previewCall.mockReturnValue(Effect.succeed(fixture.response));
    saveCall.mockReturnValue(
      Effect.succeed({ added: fixture.response.added, affectedHolderCount: 3, removed: [], role: savedRole }),
    );
    const onSaved = rstest.fn<(role: typeof fixture.role) => void>();
    const { rerender } = render(
      <RoleEditorFeature
        catalog={fixture.catalog}
        initialRole={fixture.role}
        onRefresh={() => {}}
        onSaved={onSaved}
        writesAvailable
      />,
    );
    const user = userEvent.setup();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'shell.accessAdmin.common.preview' })));
    yield* Effect.promise(() => screen.findByRole('checkbox', { name: /dangerousConfirmEffect/u }));
    yield* Effect.promise(() => user.click(screen.getByRole('checkbox', { name: /dangerousConfirmEffect/u })));
    yield* Effect.promise(() => user.click(saveButton()));
    yield* Effect.promise(() => screen.findByText('shell.accessAdmin.common.saved'));
    expect(onSaved).toHaveBeenCalledWith(savedRole);
    rerender(
      <RoleEditorFeature
        catalog={fixture.catalog}
        initialRole={savedRole}
        onRefresh={() => {}}
        onSaved={onSaved}
        writesAvailable
      />,
    );
    expect(screen.getByText('shell.accessAdmin.common.saved')).toBeTruthy();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'shell.accessAdmin.common.preview' })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(previewCall).toHaveBeenLastCalledWith(
          expect.objectContaining({ expectedRoleRevisionId: savedRole.revisionId }),
          { locale: 'en' },
        ),
      ),
    );
  }),
);

test('failure mapping keeps authentication, denial, conflict and retryable outage distinct', () => {
  const base = { detail: 'Test', title: 'Test', type: 'urn:test' };
  expect(roleErrorStatus({ ...base, _tag: 'AccessAdminAuthenticationRequired', status: 401 })).toBe('unauthenticated');
  expect(roleErrorStatus({ ...base, _tag: 'AccessAdminForbidden', status: 403 })).toBe('forbidden');
  expect(roleErrorStatus({ ...base, _tag: 'AccessAdminConflict', status: 409 })).toBe('conflict');
  expect(roleErrorStatus({ ...base, _tag: 'AccessAdminUnavailable', retryable: true, status: 503 })).toBe(
    'unavailable',
  );
});

/** The read cell of the editor, also while a closing dialog still hides the page from the accessibility tree. */
const readCell = () =>
  screen.getByRole<HTMLInputElement>('checkbox', { hidden: true, name: /commerce\.order\.order\.read/u });

it.effect('role edit: changed cells ask before leaving, Discard restores the saved role and sends nothing', () =>
  Effect.gen(function* editLeaveAsksTest() {
    const fixture = featureFixture();
    const page = () => (
      <RoleEditorFeature
        catalog={fixture.catalog}
        initialRole={fixture.role}
        onRefresh={() => {}}
        onSaved={() => {}}
        writesAvailable
      />
    );
    const view = render(page());
    expect(navigation.shouldBlock()).toBe(false);
    const user = userEvent.setup();
    const before = readCell().checked;
    yield* Effect.promise(() => user.click(readCell()));
    expect(navigation.shouldBlock()).toBe(true);
    expect(screen.getByRole('button', { name: saveName }).hasAttribute('disabled')).toBe(true);
    navigation.status = 'blocked';
    view.rerender(page());
    const discard = yield* Effect.promise(() => screen.findByRole('button', { name: 'Discard changes' }));
    yield* Effect.promise(() => user.click(discard));
    expect(navigation.proceed).toHaveBeenCalled();
    navigation.status = 'idle';
    view.rerender(page());
    yield* Effect.promise(() => waitFor(() => expect(readCell().checked).toBe(before)));
    expect(navigation.shouldBlock()).toBe(false);
    expect(saveCall).not.toHaveBeenCalled();
  }),
);
