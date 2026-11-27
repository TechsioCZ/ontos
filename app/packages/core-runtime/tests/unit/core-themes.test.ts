import { businessBrand } from '@techsio/ui-kit/theme/built-in-brands';
import { extendBrand } from '@techsio/ui-kit/theme/theme-config';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector, getActionHandler } from '../../src/testing/actions.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { tenantThemeRead } from '../../src/generated-reads/tenant-theme.ts';
import { attachTenantThemeAction, coreActionCatalog, saveTenantThemeAction } from '../../src/index.ts';
import { isGenuineCoreOperation } from '../../src/modules/module-operation-execution.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { AttachTenantThemePayloadSchema } from '../../src/themes/contract.ts';
import type { TenantThemeDefinition } from '../../src/themes/contract.ts';
import { DEFAULT_TENANT_THEME, effectiveTenantTheme, tenantThemeRevision } from '../../src/themes/definition.ts';
import { TenantThemeInvalid, TenantThemeNotFound } from '../../src/themes/errors.ts';
import type { tenantThemeRepositoryFromTransaction } from '../../src/themes/repository.ts';

/*
 * Tenant themes as Core owns them: a theme is stored only when the kit's brand validator accepts it, a tenant
 * without an attachment sees the kit's Business brand, and attaching names one of the tenant's saved themes or
 * nothing at all.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000070',
    authContextRef: 'core-themes-session',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-000000000002',
    tenantId,
  }),
  correlationId: 'core-themes',
};

const acme = extendBrand(businessBrand, {
  key: 'acme',
  label: 'Acme',
  modes: ['light', 'dark'],
  tokens: { '--color-primary': 'var(--color-primary-700)' },
});

type TenantThemeRepository = ReturnType<typeof tenantThemeRepositoryFromTransaction>;

/** The tenant's theme store in memory, with the same members the Core repository has. */
const memoryThemes = (saved: readonly TenantThemeDefinition[] = []) => {
  const themes = new Map(saved.map((theme) => [theme.key, theme]));
  let attachedKey: string | null = null;
  const repository: TenantThemeRepository = {
    attach: (themeKey) =>
      Effect.sync(() => {
        attachedKey = themeKey;
      }),
    attached: () => Effect.sync(() => (attachedKey === null ? undefined : themes.get(attachedKey))),
    detach: () =>
      Effect.sync(() => {
        attachedKey = null;
      }),
    exists: (themeKey) => Effect.sync(() => themes.has(themeKey)),
    save: (theme) =>
      Effect.sync(() => {
        themes.set(theme.key, theme);
      }),
  };
  return { attachedKey: () => attachedKey, repository, themes };
};

const contextFor = (
  action: typeof saveTenantThemeAction | typeof attachTenantThemeAction,
  repository: TenantThemeRepository,
) => {
  const collector = createActionCollector(
    action.descriptor.domainEvents,
    'core.themes',
    action.descriptor.accessEvidencePolicy,
  );
  return {
    actionInvocationId: '00000000-0000-4000-8000-000000000040',
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    compositionRevision: 'a'.repeat(64),
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope,
    services: { themes: repository },
  };
};

const save = (payload: TenantThemeDefinition, repository: TenantThemeRepository) =>
  getActionHandler(saveTenantThemeAction)(payload, contextFor(saveTenantThemeAction, repository));
const attach = (themeKey: string | null, repository: TenantThemeRepository) =>
  getActionHandler(attachTenantThemeAction)(
    Schema.decodeSync(AttachTenantThemePayloadSchema)({ themeKey }),
    contextFor(attachTenantThemeAction, repository),
  );

it('registers both Actions as tenant administration of core.themes and the read for every signed-in member', () => {
  for (const action of [saveTenantThemeAction, attachTenantThemeAction]) {
    expect(coreActionCatalog).toContain(action.descriptor);
    expect(action.descriptor.accessDeclaration).toMatchObject({ kind: 'admin', modes: ['run'], selectors: [] });
    expect(action.descriptor.legalEntityScope).toBe('forbidden');
    expect(action.descriptor.idempotency).toBe('required');
    expect(action.descriptor.owningModuleKey).toBe('core.themes');
  }
  expect(isGenuineCoreOperation(tenantThemeRead)).toBe(true);
  expect(tenantThemeRead.descriptor.entrypoint.authorization).toEqual({ kind: 'authenticated_principal' });
});

it('gives a tenant without an attachment the kit Business brand', () => {
  expect(DEFAULT_TENANT_THEME).toBe(businessBrand);
  expect(effectiveTenantTheme()).toBe(businessBrand);
  expect(effectiveTenantTheme(acme)).toBe(acme);
});

it.effect('names one exact definition by its revision', () =>
  Effect.gen(function* revisions() {
    const revision = yield* tenantThemeRevision(acme);
    expect(yield* tenantThemeRevision({ ...acme })).toBe(revision);
    expect(revision).toMatch(/^[0-9a-f]{16}$/u);
    expect(yield* tenantThemeRevision(businessBrand)).not.toBe(revision);
    expect(yield* tenantThemeRevision({ ...acme, label: 'Acme 2' })).not.toBe(revision);
  }),
);

it.effect('saves a theme the brand validator accepts and replaces the one with the same key', () =>
  Effect.gen(function* saveValid() {
    const store = memoryThemes();
    expect(yield* save(acme, store.repository)).toEqual({ themeKey: 'acme' });
    const relabelled = { ...acme, label: 'Acme Industries' };
    yield* save(relabelled, store.repository);
    expect(store.themes.get('acme')).toEqual(relabelled);
    // Saving never attaches.
    expect(store.attachedKey()).toBeNull();
  }),
);

it.effect('rejects a theme the brand validator refuses, with every issue, and stores nothing', () =>
  Effect.gen(function* saveInvalid() {
    const store = memoryThemes();
    const failure = yield* save(
      {
        ...acme,
        tokens: {
          '--color-bg-primary-base': '#ffffff',
          '--color-button-fg-primary': '#ffffff',
          '--color-not-in-the-foundation': '#000000',
        },
      },
      store.repository,
    ).pipe(Effect.flip);
    expect(Schema.is(TenantThemeInvalid)(failure) ? failure.issues : []).toEqual(
      expect.arrayContaining([
        '--color-not-in-the-foundation: not a token of the foundation',
        expect.stringMatching(/^button primary \(light\): contrast 1\.00:1/u),
      ]),
    );
    const unsafe = yield* save(
      { ...acme, tokens: { '--color-primary': 'red; } body { color: red' } },
      store.repository,
    ).pipe(Effect.flip);
    expect(Schema.is(TenantThemeInvalid)(unsafe) ? unsafe.issues : []).toEqual([
      '--color-primary: not a safe token value',
    ]);
    expect(store.themes.size).toBe(0);
  }),
);

it.effect('attaches a saved theme, refuses an unknown key and detaches back to the default', () =>
  Effect.gen(function* attachDetach() {
    const store = memoryThemes([acme]);
    expect(yield* attach('acme', store.repository)).toEqual({ themeKey: 'acme' });
    expect(effectiveTenantTheme(yield* store.repository.attached())).toBe(acme);

    const unknown = yield* attach('nobody-saved-this', store.repository).pipe(Effect.flip);
    expect(Schema.is(TenantThemeNotFound)(unknown)).toBe(true);
    expect(store.attachedKey()).toBe('acme');

    expect(yield* attach(null, store.repository)).toEqual({ themeKey: null });
    expect(effectiveTenantTheme(yield* store.repository.attached())).toBe(businessBrand);
  }),
);
