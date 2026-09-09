import { Result, Schema } from 'effect';

import { ModuleEntrypointSchema } from './module-entrypoint.ts';

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
const routeParameterPattern = /^:(?<name>[a-z][A-Za-z0-9]*)$/u;
const routeLocalePrefixPattern = /^[a-z]{2}(?:-[a-z]{2})?$/u;
const routePath = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(200),
  Schema.isPattern(
    /^\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|:[a-z][A-Za-z0-9]*)(?:\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|:[a-z][A-Za-z0-9]*))*$/u,
  ),
).pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      const segments = value.slice(1).split('/');
      if (routeLocalePrefixPattern.test(segments[0] ?? '')) {
        return 'page contribution routePath must not include a locale prefix';
      }
      const parameterNames = segments.flatMap((segment) => {
        const name = routeParameterPattern.exec(segment)?.groups?.['name'];
        return name === undefined ? [] : [name];
      });
      return new Set(parameterNames).size === parameterNames.length
        ? undefined
        : 'page contribution routePath must not repeat a parameter name';
    }),
  ),
);

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

export const ShellNavigationContributionSchema = Schema.Struct({
  contributionKey,
  entrypoint: pageEntrypoint,
  groupKey,
  order,
  pageKey,
});

export const ShellPageContributionSchema = Schema.Struct({
  componentKey,
  contributionKey,
  entrypoint: pageEntrypoint,
  routePath,
});

export const ShellPublicComponentContributionSchema = Schema.Struct({
  componentKey,
  contributionKey,
  entrypoint: componentEntrypoint,
});

export const ShellSearchContributionSchema = Schema.Struct({
  contributionKey,
  entrypoint: searchEntrypoint,
  searchKey,
});

export const ShellResourceDetailContributionSchema = Schema.Struct({
  apiKey,
  contributionKey,
  entrypoint: readableApiEntrypoint,
  resourceType: stableKey,
});

export const ShellTimelineContributionSchema = Schema.Struct({
  apiKey,
  contributionKey,
  entrypoint: readableApiEntrypoint,
  resourceType: stableKey,
});

export const ShellReportContributionSchema = Schema.Struct({
  contributionKey,
  entrypoint: reportEntrypoint,
  reportKey,
});

export const ShellMediaAttachmentContributionSchema = Schema.Struct({
  actionKey,
  apiKey,
  contributionKey,
  entrypoint: writableApiEntrypoint,
  resourceType: stableKey,
});

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
    validatePageReferences(contributions, references) ??
    validateDiscoveryReferences(contributions, references) ??
    validateResourceReferences(contributions, references) ??
    validateMediaReferences(contributions, references)
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
