import { Result, Schema } from 'effect';

import { AccessDeclarationSchema, accessCarrierIssue } from '../authorization/access-declaration.ts';
import type { AccessDeclarationInput } from '../authorization/access-declaration.ts';
import {
  CoreSearchPresentationDeclarationSchema,
  CoreSearchPresentationMetadataSchema,
  CoreShellIconSchema,
  CoreShellLabelSchema,
  CoreShellPageRoutePathSchema,
  coreShellRouteParameterNames,
} from '../search/search-contract.ts';
import type { CoreSearchPresentationMetadata } from '../search/search-contract.ts';
import type { ModuleEntrypointDescriptor } from './module-entrypoint.ts';
import { ModuleEntrypointSchema } from './module-entrypoint.ts';

const accessDeclaration = Schema.optionalKey(AccessDeclarationSchema);
/** O62: a protected Shell carrier must declare its access; an unprotected one carries none. */
const protectedDeclaration = Schema.makeFilter(
  (descriptor: {
    readonly accessDeclaration?: AccessDeclarationInput;
    readonly entrypoint: ModuleEntrypointDescriptor;
  }) => accessCarrierIssue(descriptor),
);

const stableKey = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);
const actionKey = stableKey.pipe(Schema.brand('ActionKey'));
const apiKey = stableKey.pipe(Schema.brand('ApiKey'));
const componentKey = stableKey.pipe(Schema.brand('ComponentKey'));
const contributionKey = stableKey.pipe(Schema.brand('ContributionKey'));
const groupKey = stableKey.pipe(Schema.brand('GroupKey'));
const pageKey = stableKey.pipe(Schema.brand('PageKey'));
const reportKey = stableKey.pipe(Schema.brand('ReportKey'));
const searchKey = stableKey.pipe(Schema.brand('SearchKey'));
const order = Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 10_000, minimum: 0 }));
const expose = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^\.\/[A-Za-z][A-Za-z0-9._-]*(?:\/[A-Za-z][A-Za-z0-9._-]*)*$/u),
);
const routeParameterPattern = /^:(?<name>[a-z][A-Za-z0-9]*)$/u;
const routeParameterName = Schema.String.check(Schema.isPattern(/^[a-z][A-Za-z0-9]*$/u));
const routePath = CoreShellPageRoutePathSchema;

/** The parameter names one already-validated page route template declares, in route order. */
const pageRouteParameters = (path: string): readonly string[] =>
  path
    .slice(1)
    .split('/')
    .flatMap((segment) => {
      const name = routeParameterPattern.exec(segment)?.groups?.['name'];
      return name === undefined ? [] : [name];
    });

/** Native Shell screens and ingress prefixes are never installable module page roots. */
const reservedShellRouteRoots = new Set([
  '',
  '.well-known',
  'api',
  'assets',
  'bundles',
  'locales',
  'login',
  'module-api',
  'modules',
  'resources',
  'search',
  'settings',
  'shell-super-app-api',
  'sign-in',
  'sign-out',
  'static',
]);

/** A parameter root intersects reserved Shell prefixes; an empty root selects the home screen. */
export const isReservedShellRouteRoot = (root: string | undefined): boolean =>
  root === undefined || root.startsWith(':') || reservedShellRouteRoots.has(root);

/** Validated templates have equal native precedence and intersect exactly when these keys agree. */
const pageRouteIdentity = (path: string): string =>
  path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? ':parameter' : segment))
    .join('/');

/** Linear validation across the complete approved inventory, independent of request-time matching. */
export const shellPageRouteCatalogIssue = (pages: readonly { readonly routePath: string }[]): string | undefined => {
  const claimed = new Map<string, string>();
  for (const { routePath: path } of pages) {
    if (isReservedShellRouteRoot(path.slice(1).split('/')[0])) {
      return `page contribution ${path} intersects a reserved Shell route`;
    }
    const identity = pageRouteIdentity(path);
    const previous = claimed.get(identity);
    if (previous !== undefined) {
      return `ambiguous Shell page routes ${previous} and ${path}`;
    }
    claimed.set(identity, path);
  }
  return undefined;
};

const allowsRead = (access: string): boolean => access === 'read' || access === 'historical_read';

const pageEntrypoint = ModuleEntrypointSchema.pipe(
  Schema.check(
    Schema.makeFilter((entrypoint) =>
      entrypoint.scope === 'tenant' && entrypoint.role === 'page' && allowsRead(entrypoint.access)
        ? undefined
        : 'page contribution entrypoint must be a readable tenant page',
    ),
  ),
);
const componentEntrypoint = ModuleEntrypointSchema.pipe(
  Schema.check(
    Schema.makeFilter((entrypoint) =>
      entrypoint.scope === 'tenant' && entrypoint.role === 'public_component' && allowsRead(entrypoint.access)
        ? undefined
        : 'component contribution entrypoint must be a readable tenant public component',
    ),
  ),
);
const searchEntrypoint = ModuleEntrypointSchema.pipe(
  Schema.check(
    Schema.makeFilter((entrypoint) =>
      entrypoint.scope === 'tenant' && entrypoint.role === 'search' && allowsRead(entrypoint.access)
        ? undefined
        : 'search contribution entrypoint must be a readable tenant search entrypoint',
    ),
  ),
);
const reportEntrypoint = ModuleEntrypointSchema.pipe(
  Schema.check(
    Schema.makeFilter((entrypoint) =>
      entrypoint.scope === 'tenant' && entrypoint.role === 'report' && entrypoint.access !== 'background'
        ? undefined
        : 'report contribution entrypoint must be a tenant report with compatible access',
    ),
  ),
);
const readableApiEntrypoint = ModuleEntrypointSchema.pipe(
  Schema.check(
    Schema.makeFilter((entrypoint) =>
      entrypoint.scope === 'tenant' && entrypoint.role === 'api' && allowsRead(entrypoint.access)
        ? undefined
        : 'resource contribution entrypoint must be a readable tenant API',
    ),
  ),
);
const writableApiEntrypoint = ModuleEntrypointSchema.pipe(
  Schema.check(
    Schema.makeFilter((entrypoint) =>
      entrypoint.scope === 'tenant' && entrypoint.role === 'api' && entrypoint.access === 'write'
        ? undefined
        : 'media contribution entrypoint must be a writable tenant API',
    ),
  ),
);

/** Czech and English text the Shell shows for a contribution; the Shell never names a module's destinations. */
export const ShellContributionLabelSchema = CoreShellLabelSchema;

/** Iconify utility class of the destination, e.g. `icon-[mdi--home-outline]`. */
export const ShellContributionIconSchema = CoreShellIconSchema;

/** Platform capabilities the Shell decides per person; a destination needing one is listed only with it. */
export const SHELL_NAVIGATION_CAPABILITIES = ['people_administration'] as const;

/**
 * A sidebar destination. `groupKey` places it in a Shell navigation section (`shell.navigation.<section>`); the Shell
 * owns the sections, the module owns its label, icon and order within them.
 */
export const ShellNavigationContributionSchema = Schema.Struct({
  accessDeclaration,
  contributionKey,
  entrypoint: pageEntrypoint,
  groupKey,
  /** Rank as the place to begin on the Shell Home (lower first); absent when the destination is no starting point. */
  homeStart: Schema.optionalKey(order),
  icon: ShellContributionIconSchema,
  label: ShellContributionLabelSchema,
  order,
  pageKey,
  requiresCapability: Schema.optionalKey(Schema.Literals(SHELL_NAVIGATION_CAPABILITIES)),
}).check(protectedDeclaration);

/**
 * The record a governed page opens: the page's own route parameter and the resource type that parameter identifies.
 * Both are semantic names the owner already declares, never a record route value.
 */
export const ShellPageRecordTargetSchema = Schema.Struct({
  idParameter: routeParameterName,
  resourceType: stableKey,
});

/**
 * A page contribution may opt in, one page at a time, to being opened by a tenant-authenticated session that has not
 * selected a company. The only opt-in value is `optional`; an absent key keeps the existing company requirement, so a
 * contribution that does not declare it is byte-identical to before. The Shell still admits a tenant-only request
 * only after a genuine tenant membership and the owning module's tenant `module.access` permission.
 */
export const ShellPageContributionSchema = Schema.Struct({
  accessDeclaration,
  componentKey,
  contributionKey,
  entrypoint: pageEntrypoint,
  expose,
  legalEntityScope: Schema.optionalKey(Schema.Literal('optional')),
  /**
   * The resource a page opens. `idParameter` must be the page's only route parameter and `resourceType` must be a type
   * the declaring module publishes, so the Shell can open the owner's exact record page from composed evidence.
   */
  recordTarget: Schema.optionalKey(ShellPageRecordTargetSchema),
  routePath,
}).check(protectedDeclaration);

/**
 * Offers a public component as the Home summary. The Shell renders the lowest `order` the person can open whose
 * `requiresModules` (modules whose data it shows, including its own) are all in the person's navigation.
 */
export const ShellHomePlacementSchema = Schema.Struct({
  order,
  requiresModules: Schema.Array(stableKey).check(Schema.isMinLength(1)),
});

export const ShellPublicComponentContributionSchema = Schema.Struct({
  accessDeclaration,
  componentKey,
  contributionKey,
  entrypoint: componentEntrypoint,
  expose,
  home: Schema.optionalKey(ShellHomePlacementSchema),
}).check(protectedDeclaration);

export const ShellSearchContributionSchema = Schema.Struct({
  accessDeclaration,
  contributionKey,
  entrypoint: searchEntrypoint,
  /** Optional bounded presentation; absent keeps the existing search result usable without a declared destination. */
  presentation: Schema.optionalKey(CoreSearchPresentationDeclarationSchema),
  searchKey,
}).check(protectedDeclaration);

export const ShellResourceDetailContributionSchema = Schema.Struct({
  accessDeclaration,
  apiKey,
  contributionKey,
  entrypoint: readableApiEntrypoint,
  resourceType: stableKey,
}).check(protectedDeclaration);

export const ShellTimelineContributionSchema = Schema.Struct({
  accessDeclaration,
  apiKey,
  contributionKey,
  entrypoint: readableApiEntrypoint,
  resourceType: stableKey,
}).check(protectedDeclaration);

export const ShellReportContributionSchema = Schema.Struct({
  accessDeclaration,
  contributionKey,
  entrypoint: reportEntrypoint,
  reportKey,
}).check(protectedDeclaration);

export const ShellMediaAttachmentContributionSchema = Schema.Struct({
  accessDeclaration,
  actionKey,
  apiKey,
  contributionKey,
  entrypoint: writableApiEntrypoint,
  resourceType: stableKey,
}).check(protectedDeclaration);

export const OntosShellContributionsSchema = Schema.Struct({
  mediaAttachments: Schema.Array(ShellMediaAttachmentContributionSchema),
  navigation: Schema.Array(ShellNavigationContributionSchema),
  pages: Schema.Array(ShellPageContributionSchema),
  publicComponents: Schema.Array(ShellPublicComponentContributionSchema),
  reports: Schema.Array(ShellReportContributionSchema),
  resourceDetails: Schema.Array(ShellResourceDetailContributionSchema),
  search: Schema.Array(ShellSearchContributionSchema),
  timelines: Schema.Array(ShellTimelineContributionSchema),
});

export type OntosShellContributions = Schema.Schema.Type<typeof OntosShellContributionsSchema>;

export interface ShellContributionReferenceSets {
  readonly actionKeys: ReadonlySet<string>;
  readonly apiKeys: ReadonlySet<string>;
  readonly componentKeys: ReadonlySet<string>;
  readonly moduleId: string;
  readonly reportKeys: ReadonlySet<string>;
  readonly resourceTypeKeys: ReadonlySet<string>;
  readonly searchKeys: ReadonlySet<string>;
}

/** Structural view of the manifest's declared search descriptor used by presentation binding validation. */
export interface ShellSearchPresentationDescriptor {
  readonly accessFiltering: 'legal_entity_scope' | 'resource_permission' | 'tenant_scope';
  readonly key: string;
  readonly owningModuleId: string;
  readonly resourceType: string;
}

export interface ShellSearchPresentationReferences {
  readonly moduleId: string;
  readonly resourceTypeKeys: ReadonlySet<string>;
  readonly search: readonly ShellSearchPresentationDescriptor[];
}

const referenceIssue = (set: ReadonlySet<string>, key: string, label: string): string | undefined =>
  set.has(key) ? undefined : `${label} references undeclared manifest key ${key}`;

const validatePageReferences = (
  contributions: OntosShellContributions,
  references: ShellContributionReferenceSets,
): string | undefined => {
  const pageKeys = new Set(contributions.pages.map(({ contributionKey: key }) => key));
  for (const contribution of contributions.navigation) {
    const issue = referenceIssue(pageKeys, contribution.pageKey, 'navigation contribution');
    if (issue !== undefined) {
      return issue;
    }
  }
  for (const contribution of [...contributions.pages, ...contributions.publicComponents]) {
    const issue = referenceIssue(references.componentKeys, contribution.componentKey, 'component contribution');
    if (issue !== undefined) {
      return issue;
    }
  }

  return undefined;
};

/**
 * A page's record target is bound to that page: the parameter must be the page route's only parameter, and the type
 * must be one this module publishes. One page per type keeps the Shell's exact lookup unambiguous; a second page for
 * the same record type is a manifest error, not a runtime choice.
 */
const validatePageRecordTargets = (
  contributions: OntosShellContributions,
  references: ShellContributionReferenceSets,
): string | undefined => {
  const declared = new Set<string>();
  for (const page of contributions.pages) {
    const target = page.recordTarget;
    if (target === undefined) {
      continue;
    }
    const resourceIssue = referenceIssue(references.resourceTypeKeys, target.resourceType, 'page record target');
    if (resourceIssue !== undefined) {
      return resourceIssue;
    }
    const parameters = pageRouteParameters(page.routePath);
    if (parameters.length !== 1 || parameters[0] !== target.idParameter) {
      return `page record target must name the only route parameter of ${page.routePath}`;
    }
    if (declared.has(target.resourceType)) {
      return `ambiguous page record destinations for resource type ${target.resourceType}`;
    }
    declared.add(target.resourceType);
  }
  return undefined;
};

const validateDiscoveryReferences = (
  contributions: OntosShellContributions,
  references: ShellContributionReferenceSets,
): string | undefined => {
  for (const contribution of contributions.search) {
    const issue = referenceIssue(references.searchKeys, contribution.searchKey, 'search contribution');
    if (issue !== undefined) {
      return issue;
    }
  }
  for (const contribution of contributions.reports) {
    const issue = referenceIssue(references.reportKeys, contribution.reportKey, 'report contribution');
    if (issue !== undefined) {
      return issue;
    }
  }

  return undefined;
};

/** Two declarations of one key are the same presentation when every field the metadata schema declares agrees. */
const samePresentationMetadata = Schema.toEquivalence(CoreSearchPresentationMetadataSchema);

/** Whether an earlier declaration claimed this key with a different label, icon or order. */
const disagreesWithEarlier = (
  earlier: readonly CoreSearchPresentationMetadata[],
  metadata: CoreSearchPresentationMetadata,
): boolean => earlier.some((claimed) => claimed.key === metadata.key && !samePresentationMetadata(claimed, metadata));

/**
 * Page and metadata references that need no search descriptor: exact same-owner page contribution,
 * exact existing `:parameter` (and no other placeholder) for a path selector, or a concrete page
 * route for a query selector.
 */
export const shellSearchPresentationPageIssue = (contributions: OntosShellContributions): string | undefined => {
  const pages = new Map(contributions.pages.map((page) => [String(page.contributionKey), page] as const));
  const earlierFamilies: CoreSearchPresentationMetadata[] = [];
  const earlierGroups: CoreSearchPresentationMetadata[] = [];
  for (const { presentation } of contributions.search) {
    if (presentation !== undefined) {
      if (disagreesWithEarlier(earlierFamilies, presentation.family)) {
        return `search presentation family label/icon/order must agree across contributions for key ${presentation.family.key}`;
      }
      if (disagreesWithEarlier(earlierGroups, presentation.group)) {
        return `search presentation group label/icon/order must agree across contributions for key ${presentation.group.key}`;
      }
      earlierFamilies.push(presentation.family);
      earlierGroups.push(presentation.group);
      for (const agendaPageKey of presentation.agendaPageKeys ?? []) {
        if (!pages.has(agendaPageKey)) {
          return `search presentation agenda references undeclared page contribution ${agendaPageKey}`;
        }
      }
      const { record } = presentation;
      if (record !== undefined) {
        const page = pages.get(record.pageKey);
        if (page === undefined) {
          return `search presentation record references undeclared page contribution ${record.pageKey}`;
        }
        const parameterNames = coreShellRouteParameterNames(page.routePath);
        if (record.selector.kind === 'path') {
          if (parameterNames.length !== 1 || parameterNames[0] !== record.selector.parameterName) {
            return `search presentation path selector must bind the only existing route parameter of ${page.routePath}`;
          }
        } else if (parameterNames.length > 0) {
          return `search presentation query selector requires a concrete page route ${page.routePath}`;
        }
      }
    }
  }
  return undefined;
};

export const shellSearchPresentationBindingIssue = (
  contributions: OntosShellContributions,
  references: ShellSearchPresentationReferences,
): string | undefined => {
  const descriptors = new Map<string, ShellSearchPresentationDescriptor>();
  for (const descriptor of references.search) {
    if (descriptors.has(descriptor.key)) {
      return `duplicate search descriptor key ${descriptor.key}`;
    }
    descriptors.set(descriptor.key, descriptor);
  }
  for (const { presentation, searchKey: contributionSearchKey } of contributions.search) {
    if (presentation !== undefined) {
      const descriptor = descriptors.get(contributionSearchKey);
      if (descriptor === undefined) {
        return `search presentation references undeclared search descriptor ${contributionSearchKey}`;
      }
      if (descriptor.owningModuleId !== references.moduleId) {
        return 'search presentation search descriptor owner must match the manifest module';
      }
      if (!references.resourceTypeKeys.has(descriptor.resourceType)) {
        return `search presentation references undeclared resource type ${descriptor.resourceType}`;
      }
      const expectedScope = descriptor.accessFiltering === 'tenant_scope' ? 'tenant' : 'company';
      if (presentation.scope !== expectedScope) {
        return `search presentation scope must match ${descriptor.accessFiltering} search access`;
      }
    }
  }
  return undefined;
};

const validateResourceReferences = (
  contributions: OntosShellContributions,
  references: ShellContributionReferenceSets,
): string | undefined => {
  for (const contribution of [...contributions.resourceDetails, ...contributions.timelines]) {
    const apiIssue = referenceIssue(references.apiKeys, contribution.apiKey, 'resource contribution');
    if (apiIssue !== undefined) {
      return apiIssue;
    }
    const resourceIssue = referenceIssue(
      references.resourceTypeKeys,
      contribution.resourceType,
      'resource contribution',
    );
    if (resourceIssue !== undefined) {
      return resourceIssue;
    }
  }

  return undefined;
};

const validateMediaReferences = (
  contributions: OntosShellContributions,
  references: ShellContributionReferenceSets,
): string | undefined => {
  for (const contribution of contributions.mediaAttachments) {
    const actionIssue = referenceIssue(references.actionKeys, contribution.actionKey, 'media contribution');
    if (actionIssue !== undefined) {
      return actionIssue;
    }
    const apiIssue = referenceIssue(references.apiKeys, contribution.apiKey, 'media contribution');
    if (apiIssue !== undefined) {
      return apiIssue;
    }
    const resourceIssue = referenceIssue(references.resourceTypeKeys, contribution.resourceType, 'media contribution');
    if (resourceIssue !== undefined) {
      return resourceIssue;
    }
  }
  return undefined;
};

const validateReferences = (
  contributions: OntosShellContributions,
  references: ShellContributionReferenceSets,
): string | undefined => {
  const all = [
    ...contributions.mediaAttachments,
    ...contributions.navigation,
    ...contributions.pages,
    ...contributions.publicComponents,
    ...contributions.reports,
    ...contributions.resourceDetails,
    ...contributions.search,
    ...contributions.timelines,
  ];
  const contributionKeys = all.map(({ contributionKey: key }) => key);
  if (new Set(contributionKeys).size !== contributionKeys.length) {
    return 'duplicate Shell contribution key';
  }
  for (const contribution of all) {
    if (
      contribution.entrypoint.moduleKey !== references.moduleId ||
      !contribution.entrypoint.entrypointKey.startsWith(`${references.moduleId}.`)
    ) {
      return 'Shell contribution entrypoint owner must match the manifest module';
    }
  }
  return (
    validatePageRecordTargets(contributions, references) ??
    validatePageReferences(contributions, references) ??
    validateDiscoveryReferences(contributions, references) ??
    validateResourceReferences(contributions, references) ??
    validateMediaReferences(contributions, references) ??
    shellSearchPresentationPageIssue(contributions)
  );
};

export const validateShellContributions = <Input>(
  input: Input,
  references: ShellContributionReferenceSets,
): OntosShellContributions => {
  const schema = OntosShellContributionsSchema.pipe(
    Schema.check(Schema.makeFilter((contributions) => validateReferences(contributions, references))),
  );
  return Result.getOrThrow(Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(input));
};
