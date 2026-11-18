import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { saveLabelsFor } from '@app/admin-ui';
import { RouterContextProvider } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Latch, Schema } from 'effect';
import { afterEach, expect, it, rstest, test } from 'effect-rstest';
import { createInstance } from 'i18next';
import type { ReactNode } from 'react';

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
import { roleErrorStatus } from '../../src/routes/access-admin/role-editor/role-commands.ts';
import { RoleEditorFeature } from '../../src/routes/access-admin/role-editor/role-editor-feature.tsx';
import { CreateRoleFeature } from '../../src/routes/access-admin/role-editor/create-role-feature.tsx';
import type { GetAccessRoleResponse } from '../../shared/access-admin-api.ts';
import { CurrentSessionSchema } from '../../shared/browser-api.ts';
import { adaSelectingCompany, makeShellBff, signedInShellReads } from '../support/shell-bff-double.ts';
import type { ShellBffScript } from '../support/shell-bff-double.ts';
import { ShellI18n } from '../support/shell-i18n.tsx';
import { makeShellRouter } from '../support/shell-router.tsx';
import type { ShellRouter } from '../support/shell-router.tsx';
import {
  AccessRoleSchema,
  AccessRoleTemplateSchema,
  ListAccessRoleTemplatesResponseSchema,
  PreviewAccessRoleEditResponseSchema,
} from '../../shared/access-admin-api.ts';

/**
 * Real i18next in English with no copy: every key renders as itself, followed by the named effect
 * when the view interpolates one, so assertions name the exact key the view chose.
 */
const keyEcho = createInstance();
void keyEcho
  .use({
    name: 'keyWithEffect',
    process: (value: string, _key: string | string[], options: { readonly effect?: string }) =>
      options.effect === undefined ? value : `${value}: ${options.effect}`,
    type: 'postProcessor',
  })
  .init({ initAsync: false, lng: 'en', postProcess: ['keyWithEffect'], resources: {} });
const rolesPath = '/en/access/roles';
/**
 * The Shell's i18n context and a real router standing on the roles page: the editors register their leave guards
 * with that router, so a Shell link or browser Back out of the page asks them first.
 */
const renderCopy = (ui: Parameters<typeof render>[0]) => {
  const router = makeShellRouter({ page: { component: () => null, path: 'access/roles' }, url: rolesPath });
  const ShellCopy = ({ children }: { readonly children: ReactNode }) => (
    <ShellI18n translations={keyEcho}>
      <RouterContextProvider router={router}>{children}</RouterContextProvider>
    </ShellI18n>
  );
  return { ...render(ui, { wrapper: ShellCopy }), router };
};
/** A Shell link out of the page, as the router performs it: every registered leave guard is asked first. */
const leavePage = (router: ShellRouter) => router.history.push('/en');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The role administration BFF the editor features reach through the page's own network. */
const rolesBff = (script: ShellBffScript) => makeShellBff({ ...signedInShellReads(adaSelectingCompany), ...script });

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
    renderCopy(<RoleEditorView {...input} />);
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
    const { rerender } = renderCopy(<RoleEditorView {...input} />);
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
  renderCopy(<RoleEditorView {...props()} cells={[cell, dangerous]} preview={preview} />);
  const before = screen.getByRole('region', { name: 'shell.accessAdmin.common.beforeState' });
  const after = screen.getByRole('region', { name: 'shell.accessAdmin.common.afterState' });
  expect(within(before).getByText(cell.capabilityKey)).toBeTruthy();
  expect(within(before).queryByText(dangerous.capabilityKey)).toBeNull();
  expect(within(after).getByText(dangerous.capabilityKey)).toBeTruthy();
  expect(screen.getByText('shell.accessAdmin.role.affectedPeople: 3')).toBeTruthy();
});

test('unavailable writer never advertises a working save and expiry stays assignment-owned', () => {
  renderCopy(
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
  renderCopy(<RoleEditorView {...props()} status="conflict" />);
  expect(screen.getByText('shell.accessAdmin.common.conflict')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'shell.accessAdmin.common.preview' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'shell.accessAdmin.common.refresh' }).hasAttribute('disabled')).toBe(false);
});

test('retains and displays unsupported exact targets instead of silently dropping them', () => {
  renderCopy(
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

it.effect('editing after a server preview invalidates both token and confirmations before save', () =>
  Effect.gen(function* stalePreviewTest() {
    const fixture = featureFixture();
    const bff = rolesBff({ previewAccessRoleEdit: () => Effect.succeed(fixture.response) });
    yield* Effect.gen(function* editAfterPreview() {
      renderCopy(
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
    }).pipe(Effect.provide(bff.browser));
    expect(bff.requests.map((received) => received.endpoint)).toEqual(['previewAccessRoleEdit']);
  }),
);

it.effect(
  'unavailable save retries the same idempotency key and echoes server effect without displaying its code',
  () =>
    Effect.gen(function* retryTest() {
      const fixture = featureFixture();
      const secondSave = yield* Latch.make();
      let saves = 0;
      const bff = rolesBff({
        previewAccessRoleEdit: () => Effect.succeed(fixture.response),
        saveAccessRoleEdit: () =>
          Effect.suspend(() => {
            saves += 1;
            return saves === 2 ? secondSave.open : Effect.void;
          }).pipe(
            Effect.andThen(
              Effect.fail({
                _tag: 'AccessAdminUnavailable' as const,
                detail: 'Unavailable',
                retryable: true as const,
                status: 503 as const,
                title: 'Unavailable',
                type: 'urn:test',
              }),
            ),
          ),
      });
      yield* Effect.gen(function* retrySave() {
        renderCopy(
          <RoleEditorFeature
            catalog={fixture.catalog}
            initialRole={fixture.role}
            onRefresh={() => {}}
            onSaved={() => {}}
            writesAvailable
          />,
        );
        const user = userEvent.setup();
        yield* Effect.promise(() =>
          user.click(screen.getByRole('button', { name: 'shell.accessAdmin.common.preview' })),
        );
        yield* Effect.promise(() => screen.findByRole('checkbox', { name: /dangerousConfirmEffect/u }));
        expect(document.body.textContent).not.toContain('run:action:critical');
        yield* Effect.promise(() => user.click(screen.getByRole('checkbox', { name: /dangerousConfirmEffect/u })));
        yield* Effect.promise(() => user.click(saveButton()));
        yield* Effect.promise(() => screen.findAllByText('shell.accessAdmin.common.unavailable'));
        yield* Effect.promise(() => user.click(saveButton()));
        yield* secondSave.await;
      }).pipe(Effect.provide(bff.browser));
      const saveRequests = bff.requests.filter((received) => received.endpoint === 'saveAccessRoleEdit');
      expect(saveRequests).toHaveLength(2);
      expect(saveRequests[0]?.idempotencyKey).toMatch(uuid);
      expect(saveRequests[1]?.idempotencyKey).toBe(saveRequests[0]?.idempotencyKey);
      expect(saveRequests[0]?.body).toMatchObject({
        confirmedEffects: [{ effect: 'run:action:critical', slot: 'danger-slot' }],
        previewToken: 'trusted-preview',
      });
    }),
);

it.effect('creation uses only the blank template with no cells, then selects the created role', () =>
  Effect.gen(function* blankRoleTest() {
    const fixture = featureFixture();
    const created = { ...fixture.role, cells: [] };
    const bff = rolesBff({ createAccessRole: () => Effect.succeed(created) });
    const selected = Promise.withResolvers<typeof fixture.role>();
    const role = yield* Effect.gen(function* createBlankRole() {
      const handleCreated = selected.resolve;
      renderCopy(<CreateRoleFeature catalog={blankCatalog()} onCreated={handleCreated} writesAvailable />);
      const user = userEvent.setup();
      yield* Effect.promise(() => user.type(screen.getByLabelText(/shell.accessAdmin.role.name/u), 'New role'));
      yield* Effect.promise(() => user.click(screen.getByRole('button', { name: saveName })));
      return yield* Effect.promise(() => selected.promise);
    }).pipe(Effect.provide(bff.browser));
    expect(role).toEqual(created);
    expect(bff.requests).toHaveLength(1);
    expect(bff.requests[0]).toMatchObject({
      acceptLanguage: 'en',
      body: { cells: [], name: 'New role', scope: { kind: 'tenant' }, templateKey: 'blank' },
      endpoint: 'createAccessRole',
    });
    expect(bff.requests[0]?.idempotencyKey).toMatch(uuid);
  }),
);

it.effect('creation cannot use a nonblank template or an unavailable writer', () =>
  Effect.gen(function* refusedCreation() {
    const fixture = featureFixture();
    const bff = rolesBff({});
    yield* Effect.gen(function* unavailableWriter() {
      const user = userEvent.setup();
      renderCopy(<CreateRoleFeature catalog={fixture.catalog} onCreated={() => {}} writesAvailable={false} />);
      const create = screen.getByRole('button', { name: saveName });
      expect(create.hasAttribute('disabled')).toBe(true);
      yield* Effect.promise(() => user.click(create));
    }).pipe(Effect.provide(bff.browser));
    expect(bff.requests).toEqual([]);
  }),
);

it.effect('create role: typing writes nothing, Save writes once', () =>
  Effect.gen(function* createWritesOnSaveTest() {
    const created = { ...featureFixture().role, cells: [] };
    const bff = rolesBff({ createAccessRole: () => Effect.succeed(created) });
    const selected = Promise.withResolvers<GetAccessRoleResponse['role']>();
    const role = yield* Effect.gen(function* typeThenSave() {
      const handleCreated = selected.resolve;
      renderCopy(<CreateRoleFeature catalog={blankCatalog()} onCreated={handleCreated} writesAvailable />);
      const user = userEvent.setup();
      yield* Effect.promise(() => user.type(screen.getByLabelText(/shell.accessAdmin.role.name/u), 'New role'));
      expect(bff.requests).toEqual([]);
      expect(screen.getByRole('button', { name: saveName }).hasAttribute('disabled')).toBe(false);
      yield* Effect.promise(() => user.click(screen.getByRole('button', { name: saveName })));
      return yield* Effect.promise(() => selected.promise);
    }).pipe(Effect.provide(bff.browser));
    expect(role).toEqual(created);
    expect(bff.requests.map((received) => received.endpoint)).toEqual(['createAccessRole']);
  }),
);

it.effect('create role: leaving with unsaved input asks first, Discard sends nothing', () =>
  Effect.gen(function* createLeaveAsksTest() {
    const bff = rolesBff({ createAccessRole: () => Effect.succeed({ ...featureFixture().role, cells: [] }) });
    yield* Effect.gen(function* typeThenLeave() {
      const { router } = renderCopy(
        <CreateRoleFeature catalog={blankCatalog()} onCreated={() => {}} writesAvailable />,
      );
      const user = userEvent.setup();
      yield* Effect.promise(() => user.type(screen.getByLabelText(/shell.accessAdmin.role.name/u), 'New role'));
      // The router holds the navigation (a Shell link, browser Back) and the form asks.
      leavePage(router);
      const discard = yield* Effect.promise(() => screen.findByRole('button', { name: saveLabelsFor('en').discard }));
      expect(router.history.location.pathname).toBe(rolesPath);
      yield* Effect.promise(() => user.click(discard));
      yield* Effect.promise(() => waitFor(() => expect(router.history.location.pathname).toBe('/en')));
    }).pipe(Effect.provide(bff.browser));
    expect(bff.requests).toEqual([]);
  }),
);

it.effect('tenant administration loads without a selected company and anonymous sessions do not issue role reads', () =>
  Effect.gen(function* tenantContextTest() {
    const fixture = featureFixture();
    const roleReads = {
      listAccessRoles: () => Effect.succeed({ items: [fixture.role], nextCursor: null }),
      listAccessRoleTemplates: () => Effect.succeed(fixture.catalog),
    } satisfies ShellBffScript;
    const tenantBff = rolesBff(roleReads);
    const model = yield* loadRolePageModel(new Request('https://app.example.test/en/access/roles')).pipe(
      Effect.provide(tenantBff.browser),
    );
    expect(model.state).toBe('ready');
    const roleRequests = tenantBff.requests.filter((received) => received.endpoint.startsWith('listAccessRole'));
    const sentReads = roleRequests.map(({ body, endpoint, url }) => ({ body, endpoint, url }));
    // The two reads run concurrently; their order is not part of the contract.
    expect(sentReads).toHaveLength(2);
    expect(sentReads).toEqual(
      expect.arrayContaining([
        {
          body: { limit: 100 },
          endpoint: 'listAccessRoleTemplates',
          url: 'https://app.example.test/shell-super-app-api/shell/access/roles/templates',
        },
        {
          body: { limit: 100 },
          endpoint: 'listAccessRoles',
          url: 'https://app.example.test/shell-super-app-api/shell/access/roles/list',
        },
      ]),
    );
    const anonymousBff = rolesBff({
      ...roleReads,
      currentSession: () => Effect.succeed(Schema.decodeUnknownSync(CurrentSessionSchema)({ state: 'anonymous' })),
    });
    const anonymous = yield* loadRolePageModel(new Request('https://app.example.test/en/access/roles')).pipe(
      Effect.provide(anonymousBff.browser),
    );
    expect(anonymous.state).toBe('unauthenticated');
    expect(anonymousBff.requests.map((received) => received.endpoint)).toEqual(['currentSession']);
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
    const bff = rolesBff({
      previewAccessRoleEdit: () => Effect.succeed(fixture.response),
      saveAccessRoleEdit: () =>
        Effect.succeed({ added: fixture.response.added, affectedHolderCount: 3, removed: [], role: savedRole }),
    });
    const onSaved = rstest.fn<(role: typeof fixture.role) => void>();
    yield* Effect.gen(function* saveThenPreview() {
      const { rerender } = renderCopy(
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
      yield* Effect.promise(() => screen.findByRole('checkbox', { name: /dangerousConfirmEffect/u }));
    }).pipe(Effect.provide(bff.browser));
    const previews = bff.requests.filter((received) => received.endpoint === 'previewAccessRoleEdit');
    expect(previews).toHaveLength(2);
    expect(previews.at(-1)).toMatchObject({
      acceptLanguage: 'en',
      body: { expectedRoleRevisionId: savedRole.revisionId },
    });
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
    const bff = rolesBff({});
    yield* Effect.gen(function* editThenLeave() {
      const { router } = renderCopy(
        <RoleEditorFeature
          catalog={fixture.catalog}
          initialRole={fixture.role}
          onRefresh={() => {}}
          onSaved={() => {}}
          writesAvailable
        />,
      );
      const user = userEvent.setup();
      const before = readCell().checked;
      yield* Effect.promise(() => user.click(readCell()));
      expect(screen.getByRole('button', { name: saveName }).hasAttribute('disabled')).toBe(true);
      // The router holds the navigation and the editor asks.
      leavePage(router);
      const discard = yield* Effect.promise(() => screen.findByRole('button', { name: saveLabelsFor('en').discard }));
      expect(router.history.location.pathname).toBe(rolesPath);
      yield* Effect.promise(() => user.click(discard));
      yield* Effect.promise(() => waitFor(() => expect(router.history.location.pathname).toBe('/en')));
      yield* Effect.promise(() => waitFor(() => expect(readCell().checked).toBe(before)));
      // Restored: nothing is left to ask about, so the next navigation goes through at once.
      router.history.push(rolesPath);
      yield* Effect.promise(() => waitFor(() => expect(router.history.location.pathname).toBe(rolesPath)));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    }).pipe(Effect.provide(bff.browser));
    expect(bff.requests).toEqual([]);
  }),
);
