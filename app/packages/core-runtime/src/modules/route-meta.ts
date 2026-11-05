import { Result, Schema } from 'effect';

import { AccessDeclarationSchema, accessCarrierIssue } from '../authorization/access-declaration.ts';
import { ModuleEntrypointSchema } from './module-entrypoint.ts';

/** A module or route identifier: lowercase segments joined by a dot or a hyphen. */
const stableKey = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('RouteMetaStableKey'));
/** A dotted translation key such as `assortment.seo.description`; a segment may contain inner hyphens (`party-registry.pages.contacts.title`). */
const translationKey = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?:\.[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)+$/u),
).pipe(Schema.brand('RouteMetaTranslationKey'));
/** One route path without a locale prefix; `:name` is a parameter and `*` a catch-all segment. */
const routePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^\/(?:[a-z0-9-]+|:[A-Za-z][A-Za-z0-9]*|\*)?(?:\/(?:[a-z0-9-]+|:[A-Za-z][A-Za-z0-9]*))*$/u),
);
const localePattern = /^[a-z]{2}(?:-[a-z]{2})?$/u;
/** One path per locale; the Shell mounts every locale under its own prefix. */
const localisedPaths = Schema.Record(Schema.String, routePath).check(
  Schema.makeFilter((paths) => {
    const locales = Object.keys(paths);
    if (locales.length === 0) {
      return 'route meta must declare at least one localised path';
    }
    return locales.every((key) => localePattern.test(key))
      ? undefined
      : `route meta localised path keys must be locale codes such as cs or en, not ${locales.find((key) => !localePattern.test(key)) ?? ''}`;
  }),
);
/** The module-federation boundary the page bundle runs in, e.g. `shellSuperApp`. */
const federationBoundaryId = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*$/u)).pipe(
  Schema.brand('RouteMetaFederationBoundaryId'),
);
/** A lowercase kebab surface or namespace name. */
const surface = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u));
/** The application that owns the page, e.g. `shell-super-app`. */
const ownerAppId = surface.pipe(Schema.brand('RouteMetaOwnerAppId'));

/** A page is a readable page entrypoint in either module scope; admin pages need no legal entity (O28). */
const pageEntrypoint = ModuleEntrypointSchema.check(
  Schema.makeFilter((entrypoint) =>
    entrypoint.role === 'page' && (entrypoint.access === 'read' || entrypoint.access === 'historical_read')
      ? undefined
      : 'route meta entrypoint must be a readable page',
  ),
);

/**
 * The page carrier of route metadata (CUTOVER-PLAN §4.3): the entrypoint classifies the page and
 * `accessDeclaration` decides it. Kept as its own field bag so nothing else in this module is
 * mistaken for a descriptor.
 */
const routeMetaAccessFields = {
  accessDeclaration: Schema.optionalKey(AccessDeclarationSchema),
  entrypoint: pageEntrypoint,
};

/** The route identity every page carries, whatever its classification. */
const routeMetaRouteFields = {
  /** The route as authored, without a locale prefix; `-` and `:parameter` segments are allowed. */
  canonicalPath: routePath,
  descriptionKey: translationKey,
  id: stableKey,
  indexable: Schema.Boolean,
  localisedPaths,
  mfBoundaryId: federationBoundaryId,
  /** Present for a module-owned page; a Shell-owned page has no module of its own. */
  moduleId: Schema.optionalKey(stableKey),
  namespace: surface,
  ownerAppId,
  public: Schema.Boolean,
  publicSurface: surface,
  titleKey: translationKey,
};

/**
 * The generator wraps every `route.meta.ts` in `defineRouteMeta`, so a page classification can no
 * longer drift from its declaration — a `protected` page without one is a definition-time error (O62).
 */
export const RouteMetaSchema = Schema.Struct({
  ...routeMetaAccessFields,
  ...routeMetaRouteFields,
}).check(
  Schema.makeFilter((meta) => {
    const carrierIssue = accessCarrierIssue(meta);
    if (carrierIssue !== undefined) {
      return carrierIssue;
    }
    const [root = ''] = meta.canonicalPath.slice(1).split('/');
    if (root.length > 0 && /^[a-z]{2}(?:-[a-z]{2})?$/u.test(root)) {
      return 'route meta canonicalPath must not include a locale prefix';
    }
    // `String(...)` erases the local brand: the entrypoint carries its own identifier type.
    if (meta.moduleId !== undefined && String(meta.moduleId) !== meta.entrypoint.moduleKey) {
      return `route meta moduleId ${meta.moduleId} must be the moduleKey of its page entrypoint ${meta.entrypoint.moduleKey}`;
    }
    return meta.entrypoint.entrypointKey.startsWith(`${meta.entrypoint.moduleKey}.`)
      ? undefined
      : `route meta entrypoint ${meta.entrypoint.entrypointKey} must be owned by ${meta.entrypoint.moduleKey}`;
  }),
);

/** A decoded route metadata record: the uniform page carrier every consumer may read. */
export type RouteMeta = typeof RouteMetaSchema.Type;
/** The shape a route module author writes. */
export type RouteMetaInput = typeof RouteMetaSchema.Encoded;

const RouteMetaDefinitionError = Schema.TaggedError<Error>()('RouteMetaDefinitionError', {
  message: Schema.String,
});

const decodeRouteMeta = Schema.decodeUnknownResult(RouteMetaSchema, { onExcessProperty: 'error' });

/**
 * Definition-time constructor (O5): validates the page carrier against its entrypoint and returns
 * the authored literal, so the generated route metadata keeps its concrete paths and keys. A
 * consumer of a mixed page set narrows the optional carrier with `in` (`routeMetaIssue` explains a
 * rejected literal).
 */
export const defineRouteMeta = <const Meta extends RouteMetaInput>(meta: Meta): Readonly<Meta> => {
  const decoded = decodeRouteMeta(meta);
  if (Result.isFailure(decoded)) {
    throw new RouteMetaDefinitionError({ message: `route meta is invalid: ${decoded.failure.message}` });
  }
  return Object.freeze(meta);
};

/** Non-throwing route metadata check for tooling; the first actionable reason, if any (O5). */
export const routeMetaIssue = (meta: RouteMetaInput): string | undefined => {
  const decoded = decodeRouteMeta(meta);
  return Result.isFailure(decoded) ? decoded.failure.message : undefined;
};
