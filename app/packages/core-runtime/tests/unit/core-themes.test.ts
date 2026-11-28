import { businessBrand } from '@techsio/ui-kit/theme/built-in-brands';
import { extendBrand } from '@techsio/ui-kit/theme/theme-config';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Schema, Struct } from 'effect';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import {
  bindActionTestServices,
  createActionCollector,
  getActionHandler,
  makeActionTestHarness,
} from '../../src/testing/actions.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { tenantThemeRead } from '../../src/generated-reads/tenant-theme.ts';
import { attachTenantThemeAction, coreActionCatalog, saveTenantThemeAction } from '../../src/index.ts';
import { isGenuineCoreOperation } from '../../src/modules/module-operation-execution.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { OperationContextInvalid } from '../../src/operations/operation-context-invalid.ts';
import { ReadHandlerUnavailable } from '../../src/reads/errors.ts';
import { AttachTenantThemePayloadSchema } from '../../src/themes/contract.ts';
import type { TenantThemeDefinition } from '../../src/themes/contract.ts';
import { TenantThemeKit, tenantThemeRevision } from '../../src/themes/definition.ts';
import type { TenantThemeKitService } from '../../src/themes/definition.ts';
import { TenantThemeInvalid, TenantThemeNotFound } from '../../src/themes/errors.ts';
import { TenantThemeKitLive } from '../../src/themes/kit.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import type { tenantThemeRepositoryFromTransaction } from '../../src/themes/repository.ts';

/*
 * Tenant themes as Core owns them, with the kit bound the way the Shell binds it: a theme is stored only when the
 * kit's brand validator accepts it, a tenant without an attachment sees the kit's Business brand, and attaching names
 * one of the tenant's saved themes or nothing at all.
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

const contextFor = <Services>(
  action: typeof saveTenantThemeAction | typeof attachTenantThemeAction,
  services: Services,
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
    services,
  };
};

/** One Action request of the Shell, under its own idempotency key. */
const themeTransport = (idempotencyKey: string) => ({ correlationId: 'core-themes', idempotencyKey });

const save = (payload: TenantThemeDefinition, repository: TenantThemeRepository) =>
  TenantThemeKit.pipe(
    Effect.flatMap((kit: TenantThemeKitService) =>
      getActionHandler(saveTenantThemeAction)(payload, contextFor(saveTenantThemeAction, { kit, themes: repository })),
    ),
  );
const attach = (themeKey: string | null, repository: TenantThemeRepository) =>
  getActionHandler(attachTenantThemeAction)(
    Schema.decodeSync(AttachTenantThemePayloadSchema)({ themeKey }),
    contextFor(attachTenantThemeAction, { themes: repository }),
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

it.effect('names one exact definition by its revision', () =>
  Effect.gen(function* revisions() {
    const revision = yield* tenantThemeRevision(acme);
    expect(yield* tenantThemeRevision({ ...acme })).toBe(revision);
    expect(revision).toMatch(/^[0-9a-f]{16}$/u);
    expect(yield* tenantThemeRevision(businessBrand)).not.toBe(revision);
    expect(yield* tenantThemeRevision({ ...acme, label: 'Acme 2' })).not.toBe(revision);
  }),
);

it.effect('names a theme by its content, not by the order of its keys', () =>
  Effect.gen(function* keyOrder() {
    // As jsonb gives a stored theme back: the same tokens, in another order.
    const reordered = { ...acme, tokens: Object.fromEntries(Object.entries(acme.tokens).toReversed()) };
    expect(Object.keys(reordered.tokens)).not.toEqual(Object.keys(acme.tokens));
    expect(yield* tenantThemeRevision(reordered)).toBe(yield* tenantThemeRevision(acme));
    const components = {
      button: { size: 'sm' },
      input: { appearance: 'outline', size: 'lg' },
    };
    const reversedComponents = Object.fromEntries(Object.entries(components).toReversed());
    expect(yield* tenantThemeRevision({ ...acme, defaults: { components: reversedComponents } })).toBe(
      yield* tenantThemeRevision({ ...acme, defaults: { components } }),
    );
    // The order of the modes is the theme's own.
    expect(yield* tenantThemeRevision({ ...acme, modes: ['dark', 'light'] })).not.toBe(
      yield* tenantThemeRevision(acme),
    );
  }),
);

it.layer(TenantThemeKitLive)('with the kit bound as the Shell binds it', (suite) => {
  suite.effect('gives a tenant without an attachment the kit Business brand', () =>
    Effect.gen(function* kitDefault() {
      expect((yield* TenantThemeKit).defaultTheme).toEqual(businessBrand);
    }),
  );

  suite.effect('saves a theme the brand validator accepts and replaces the one with the same key', () =>
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

  suite.effect('rejects a theme the brand validator refuses, with every issue, and stores nothing', () =>
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

  // PostgreSQL stores no NUL character, so a theme with one must fail as invalid before the store, not as an outage.
  suite.effect('rejects a NUL character in any stored string as invalid and stores nothing', () =>
    Effect.gen(function* saveNul() {
      const store = memoryThemes();
      const failure = yield* save(
        {
          ...acme,
          defaults: {
            components: { 'but\u0000ton': { size: 'sm' }, input: { appearance: 'out\u0000line', size: 'lg' } },
          },
          label: 'Ac\u0000me',
        },
        store.repository,
      ).pipe(Effect.flip);
      expect(Schema.is(TenantThemeInvalid)(failure) ? failure.issues : []).toEqual([
        'label: must not contain a NUL character',
        'defaults.components: a name must not contain a NUL character',
        'defaults.components.input.appearance: must not contain a NUL character',
      ]);
      expect(store.themes.size).toBe(0);
    }),
  );

  /*
   * Both Actions through the real Action runtime, as the Shell calls them for an administrator who has a company
   * selected. They are tenant-wide (`forbidden` company scope), so the runtime refuses a principal that carries one:
   * the Shell drops the selected company, as it does for the tenant theme read.
   */
  suite.effect('saves and attaches for an administrator with a company selected once the company is dropped', () =>
    Effect.gen(function* administratorWithCompany() {
      const kit = yield* TenantThemeKit;
      const store = memoryThemes();
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        services: [
          bindActionTestServices(saveTenantThemeAction, { kit, themes: store.repository }),
          bindActionTestServices(attachTenantThemeAction, { themes: store.repository }),
        ],
      });
      const withCompany = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        ...Struct.omit(scope, ['correlationId']),
        legalEntityId: '00000000-0000-4000-8000-000000000003',
      });
      const tenantWide = Struct.omit(withCompany, ['legalEntityId']);

      const refused = yield* harness.runtime
        .runAction({
          payload: acme,
          principal: withCompany,
          registration: saveTenantThemeAction,
          transport: themeTransport('save-with-company'),
        })
        .pipe(Effect.flip);
      expect(Schema.is(OperationContextInvalid)(refused)).toBe(true);
      expect(store.themes.size).toBe(0);

      expect(
        yield* harness.runtime.runAction({
          payload: acme,
          principal: tenantWide,
          registration: saveTenantThemeAction,
          transport: themeTransport('save'),
        }),
      ).toEqual({ themeKey: 'acme' });
      expect(
        yield* harness.runtime.runAction({
          payload: yield* Schema.decodeEffect(AttachTenantThemePayloadSchema)({ themeKey: 'acme' }),
          principal: tenantWide,
          registration: attachTenantThemeAction,
          transport: themeTransport('attach'),
        }),
      ).toEqual({ themeKey: 'acme' });
      expect(store.attachedKey()).toBe('acme');
    }),
  );
});

it.effect('attaches a saved theme, refuses an unknown key and detaches back to the default', () =>
  Effect.gen(function* attachDetach() {
    const store = memoryThemes([acme]);
    expect(yield* attach('acme', store.repository)).toEqual({ themeKey: 'acme' });
    expect(yield* store.repository.attached()).toBe(acme);

    const unknown = yield* attach('nobody-saved-this', store.repository).pipe(Effect.flip);
    expect(Schema.is(TenantThemeNotFound)(unknown)).toBe(true);
    expect(store.attachedKey()).toBe('acme');

    expect(yield* attach(null, store.repository)).toEqual({ themeKey: null });
    expect(yield* store.repository.attached()).toBeUndefined();
  }),
);

/*
 * The read through the real Read runtime, as the Shell calls it: a signed-in member, without a company (the Shell
 * drops a selected one, the theme is the tenant's), gets the tenant's theme. Only the SQL transport is scripted. While
 * the read declared `optional` company scope, it answered every member with ReadPermissionUnavailable (a Shell 503).
 */
it.layer(Layer.merge(NodeCrypto.layer, TenantThemeKitLive))('the tenant theme read in the Read runtime', (suite) => {
  suite.effect('answers a signed-in member of the tenant without any company', () =>
    Effect.gen(function* memberReadsTheme() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-11-27T09:00:00.000Z'))),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const answer = yield* harness.runtime.runRead({
        input: {},
        principal: Struct.omit(scope, ['correlationId']),
        registration: tenantThemeRead,
        transport: { correlationId: 'core-themes' },
      });
      expect(answer).toEqual({ revision: yield* tenantThemeRevision(businessBrand), theme: businessBrand });
      expect(harness.snapshot().ownerQueries.map((query) => query.scope.tenantId)).toEqual([tenantId]);
    }),
  );

  // A store that cannot answer is an outage, never "no theme attached": the member must not get the Business brand.
  suite.effect('fails as unavailable when the theme store query fails', () =>
    Effect.gen(function* storeOutage() {
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () =>
          Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled outage' }) })),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(Date.parse('2026-11-27T09:00:00.000Z'))),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      });
      const failure = yield* harness.runtime
        .runRead({
          input: {},
          principal: Struct.omit(scope, ['correlationId']),
          registration: tenantThemeRead,
          transport: { correlationId: 'core-themes' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );
});
