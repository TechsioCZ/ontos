import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { defineSystemModuleEntrypoint, defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { RouteMetaSchema, defineRouteMeta, routeMetaIssue } from '../../src/modules/route-meta.ts';

/** The Shell-owned public login page: no module of its own and no carrier (LANE-CONTRACT). */
const loginRouteMeta = () =>
  ({
    canonicalPath: '/login',
    descriptionKey: 'shell.login.seo.description',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'public' },
      entrypointKey: 'shell-super-app.page.login',
      moduleKey: 'shell-super-app',
      role: 'page',
    }),
    id: 'shell-login',
    indexable: false,
    localisedPaths: { cs: '/login', en: '/login' },
    mfBoundaryId: 'shellSuperApp',
    namespace: 'shell',
    ownerAppId: 'shell-super-app',
    public: false,
    publicSurface: 'private-app-screen',
    titleKey: 'shell.login.title',
  }) as const;

const declaredAssortmentHome = (): AccessDeclarationInput => ({
  key: 'commerce.assortment.home.read',
  kind: 'read',
  modes: ['run'],
  placement: { group: 'configuration', level: 'basic' },
  risk: 'routine',
  selectors: [],
});

/** A module-owned protected page: the tenant scope and a dotted module key (a vertical route meta). */
const assortmentHomeRouteMeta = (accessDeclaration: AccessDeclarationInput = declaredAssortmentHome()) =>
  ({
    accessDeclaration,
    canonicalPath: '/',
    descriptionKey: 'assortment.seo.description',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'assortment.configuration.read' },
      entrypointKey: 'commerce.assortment.page.assortment-home',
      moduleKey: 'commerce.assortment',
      role: 'page',
    }),
    id: 'assortment-home',
    indexable: false,
    localisedPaths: { cs: '/', en: '/' },
    mfBoundaryId: 'verticalAssortment',
    moduleId: 'commerce.assortment',
    namespace: 'assortment',
    ownerAppId: 'assortment',
    public: false,
    publicSurface: 'private-app-screen',
    titleKey: 'assortment.title',
  }) as const;

it('validates a Shell public page and keeps its literal paths frozen', () => {
  const routeMeta = defineRouteMeta(loginRouteMeta());
  expect(routeMeta.canonicalPath).toBe('/login');
  expect(routeMeta.entrypoint.authorization.kind).toBe('public');
  // An unprotected page carries no declaration key at all, so a consumer narrows with `in`.
  expect('accessDeclaration' in routeMeta).toBe(false);
  expect(Object.isFrozen(routeMeta)).toBe(true);
});

it('validates a protected module page that declares its own capability (O62)', () => {
  const routeMeta = defineRouteMeta(assortmentHomeRouteMeta());
  expect(routeMeta.accessDeclaration?.key).toBe('commerce.assortment.home.read');
  expect(routeMeta.moduleId).toBe('commerce.assortment');
  expect(routeMetaIssue(assortmentHomeRouteMeta())).toBeUndefined();
});

it('refuses a protected page that carries no access carrier', () => {
  const { accessDeclaration: strippedDeclaration, ...bare } = assortmentHomeRouteMeta();
  expect(strippedDeclaration.key).toBe('commerce.assortment.home.read');
  expect(() => defineRouteMeta(bare)).toThrow(/must declare accessDeclaration, accessWorkload or accessActor/u);
  expect(routeMetaIssue(bare)).toContain('must declare accessDeclaration, accessWorkload or accessActor');
});

it('refuses a declaration that does not belong to its page entrypoint', () => {
  // Negative controls: the carrier is validated against the entrypoint, not in isolation.
  const proposesOnAPage = {
    ...assortmentHomeRouteMeta(),
    accessDeclaration: { ...declaredAssortmentHome(), modes: ['run', 'propose'] as const },
  };
  expect(() => defineRouteMeta(proposesOnAPage)).toThrow(/support only run mode/u);
  expect(routeMetaIssue(proposesOnAPage)).toContain('support only run mode');

  const routineDelete = {
    ...assortmentHomeRouteMeta(),
    accessDeclaration: { ...declaredAssortmentHome(), key: 'commerce.assortment.home.delete' },
  };
  expect(() => defineRouteMeta(routineDelete)).toThrow(/dangerous verb/u);
  expect(routeMetaIssue(routineDelete)).toContain('dangerous verb');
});

it('binds the route metadata to a readable page entrypoint of the declared module', () => {
  const invalid: readonly [() => object, RegExp][] = [
    // The module of the page is the module of the route.
    [
      () => defineRouteMeta({ ...assortmentHomeRouteMeta(), moduleId: 'commerce.catalog' }),
      /must be the moduleKey of its page entrypoint/u,
    ],
    [
      () =>
        defineRouteMeta({
          ...assortmentHomeRouteMeta(),
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'assortment.configuration.read' },
            entrypointKey: 'commerce.catalog.page.home',
            moduleKey: 'commerce.assortment',
            role: 'page',
          }),
        }),
      /must be owned by commerce\.assortment/u,
    ],
    // Only a page is route metadata; an API entrypoint is not a screen.
    [
      () =>
        defineRouteMeta({
          ...assortmentHomeRouteMeta(),
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'assortment.configuration.read' },
            entrypointKey: 'commerce.assortment.api.home',
            moduleKey: 'commerce.assortment',
            role: 'api',
          }),
        }),
      /must be a readable page/u,
    ],
    // Locale prefixes belong to the generated URL table, never to the authored path.
    [
      () => defineRouteMeta({ ...assortmentHomeRouteMeta(), canonicalPath: '/cs' }),
      /must not include a locale prefix/u,
    ],
  ];
  for (const [control, reason] of invalid) {
    expect(control).toThrow(reason);
  }
});

it('rejects malformed route metadata instead of publishing it', () => {
  const withQuery = { ...assortmentHomeRouteMeta(), canonicalPath: '/assortment?tab=1' };
  expect(() => defineRouteMeta(withQuery)).toThrow(/canonicalPath/u);
  // Unknown fields are refused, so a typo cannot silently become metadata.
  const withUnknownField = { ...assortmentHomeRouteMeta(), path: '/' };
  expect(() => defineRouteMeta(withUnknownField)).toThrow(/path/u);
  expect(routeMetaIssue(withUnknownField)).toBeDefined();

  const malformed: readonly unknown[] = [
    // Only locale keys address localised paths.
    { ...assortmentHomeRouteMeta(), localisedPaths: { czech: '/' } },
    // A path always starts with exactly one slash.
    { ...assortmentHomeRouteMeta(), canonicalPath: 'assortment' },
    // A caller cannot claim another application as the page owner's boundary.
    { ...assortmentHomeRouteMeta(), mfBoundaryId: 'vertical-assortment' },
    // Discovery flags are booleans, never strings.
    { ...assortmentHomeRouteMeta(), indexable: 'yes' },
    // A page the Shell cannot mount in any locale is not metadata.
    { ...assortmentHomeRouteMeta(), localisedPaths: {} },
  ];
  for (const meta of malformed) {
    expect(Schema.is(RouteMetaSchema)(meta)).toBe(false);
  }
});

it('accepts the hyphenated module segments the locale files use and still refuses malformed keys', () => {
  const hyphenated = {
    ...assortmentHomeRouteMeta(),
    descriptionKey: 'party-registry.pages.contacts.description',
    titleKey: 'party-registry.pages.contacts.title',
  };
  expect(Schema.is(RouteMetaSchema)(hyphenated)).toBe(true);
  for (const titleKey of ['party-registry', 'party-.title', 'party--registry.title', '-party.title', 'Party.title']) {
    expect(Schema.is(RouteMetaSchema)({ ...assortmentHomeRouteMeta(), titleKey })).toBe(false);
  }
});
