import { getI18nInstance as createModernI18n } from '@modern-js/plugin-i18n/i18n';
import type { I18nInstance } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import {
  AgentAccessClientIdSchema,
  AgentAccessGrantIdSchema,
  ConnectionSummarySchema,
} from '@app/shared-contracts/agent-access';
import type { ConnectionLimits, ConnectionSummary } from '@app/shared-contracts/agent-access';
import { AgentModuleKeySchema, AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { cleanup, render as renderView, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Schema } from 'effect';
import { afterEach, beforeAll, expect, it, rstest } from 'effect-rstest';
import type { PropsWithChildren, ReactElement } from 'react';

import csResource from '../../locales/cs/shell.json';
import { ConnectedAppsEditPanel } from '../../src/routes/[lang]/profile/connected-apps-edit-panel.tsx';

let i18nInstance: I18nInstance;
beforeAll(async () => {
  i18nInstance = await createModernI18n();
  await i18nInstance.init({
    defaultNS: 'shell',
    lng: 'cs',
    ns: ['shell'],
    resources: { cs: { shell: csResource } },
    supportedLngs: ['cs', 'en'],
  });
});
const I18nProvider = ({ children }: PropsWithChildren) => (
  <ModernI18nProvider value={{ i18nInstance, language: 'cs', languages: ['cs', 'en'] }}>{children}</ModernI18nProvider>
);
const render = (ui: ReactElement) => renderView(ui, { wrapper: I18nProvider });
afterEach(cleanup);

const { update } = rstest.hoisted(() => ({ update: rstest.fn() }));
rstest.mock('../../src/routes/[lang]/profile/connected-apps-client.ts', () => ({
  updateConnectionAccess: update,
}));

const warehouse = AgentModuleKeySchema.make('warehouse');
const limits: ConnectionLimits = {
  maxWritePolicy: 'approval',
  modules: [{ label: 'Sklad', moduleId: warehouse, read: true, write: true }],
};
const connection: ConnectionSummary = Schema.decodeUnknownSync(ConnectionSummarySchema)({
  acting: { displayName: 'Jana Nováková', kind: 'human', principalId: AgentPrincipalIdSchema.make('person-1') },
  allModules: false,
  client: {
    clientId: AgentAccessClientIdSchema.make('client-a'),
    host: 'chatgpt.com',
    kind: 'cimd',
    logoUri: null,
    name: 'ChatGPT',
  },
  createdAt: '2026-10-01T10:00:00.000Z',
  delegatedBy: null,
  granted: { modules: [{ access: 'write', moduleId: warehouse }], writePolicy: 'approval' },
  grantId: AgentAccessGrantIdSchema.make('g1'),
  lastUsedAt: null,
  legalEntityId: 'company-a',
  legalName: 'Firma A',
  limits,
  live: true,
  modules: [{ label: 'Sklad', moduleId: warehouse, read: true, write: true }],
  profileId: 'profile-1',
  revokedAt: null,
  revokeNote: null,
  revokeReason: null,
  status: 'active',
  tenantId: 'tenant-1',
  user: { displayName: 'Jana Nováková', principalId: AgentPrincipalIdSchema.make('person-1') },
  writePolicy: 'approval',
});

/** The panel footer's Zavřít; the dialog's own close trigger carries the same label. */
const closeButton = (): HTMLElement => {
  const last = screen.getAllByRole('button', { name: 'Zavřít' }).at(-1);
  if (last === undefined) {
    throw new Error('The panel footer has no Zavřít button.');
  }
  return last;
};

const click = (element: HTMLElement) =>
  Effect.promise(async () => {
    await userEvent.setup().click(element);
  });

const ok = Effect.succeed({ status: 'ok', value: {} });

const saveButton = (): HTMLElement => {
  const button = screen.getByRole('button', { name: 'Uložit' });
  return button;
};

it.live('changing the access writes nothing until Uložit, which writes once', () =>
  Effect.gen(function* editThenSave() {
    update.mockReturnValue(ok);
    const onClose = rstest.fn<() => void>();
    const onSaved = rstest.fn<(name: string) => void>();
    const onStale = rstest.fn<(notice: string) => void>();
    render(<ConnectedAppsEditPanel connection={connection} onClose={onClose} onSaved={onSaved} onStale={onStale} />);
    yield* click(screen.getByRole('radio', { name: 'Jen čtení' }));
    yield* Effect.sleep('1 second');
    expect(update).not.toHaveBeenCalled();
    yield* click(saveButton());
    yield* Effect.promise(async () => {
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1), { timeout: 4000 });
    });
    expect(update.mock.calls[0]?.[0]).toMatchObject({ grantId: 'g1', writePolicy: 'read_only' });
  }),
);

it.effect('leaving with unsaved changes asks first, and Zahodit změny sends nothing', () =>
  Effect.gen(function* leaveAsks() {
    update.mockReturnValue(ok);
    const onClose = rstest.fn<() => void>();
    const onSaved = rstest.fn<(name: string) => void>();
    const onStale = rstest.fn<(notice: string) => void>();
    render(<ConnectedAppsEditPanel connection={connection} onClose={onClose} onSaved={onSaved} onStale={onStale} />);
    yield* click(screen.getByRole('radio', { name: 'Jen čtení' }));
    yield* click(closeButton());
    expect(onClose).not.toHaveBeenCalled();
    yield* click(screen.getByRole('button', { name: 'Zahodit změny' }));
    expect(update).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  }),
);

it.effect('says so and closes when the connection was revoked elsewhere', () =>
  Effect.gen(function* revokedElsewhere() {
    update.mockReturnValue(Effect.succeed({ detail: null, reason: 'conflict', status: 'failed' }));
    const onClose = rstest.fn<() => void>();
    const onSaved = rstest.fn<(name: string) => void>();
    const onStale = rstest.fn<(notice: string) => void>();
    render(<ConnectedAppsEditPanel connection={connection} onClose={onClose} onSaved={onSaved} onStale={onStale} />);
    yield* click(screen.getByRole('radio', { name: 'Jen čtení' }));
    yield* click(saveButton());
    yield* Effect.promise(async () => {
      await waitFor(() => expect(onStale).toHaveBeenCalled(), { timeout: 4000 });
    });
  }),
);
