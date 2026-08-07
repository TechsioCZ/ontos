import { Schema } from 'effect';
import { ModuleEntrypointSchema } from './module-entrypoint.ts';

const stableKey = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);
const order = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 10_000, minimum: 0 }),
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
      entrypoint.scope === 'tenant' &&
      entrypoint.role === 'public_component' &&
      allowsRead(entrypoint.access)
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
      entrypoint.scope === 'tenant' &&
      entrypoint.role === 'report' &&
      entrypoint.access !== 'background'
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
  contributionKey: stableKey,
  entrypoint: pageEntrypoint,
  groupKey: stableKey,
  order,
  pageKey: stableKey,
});

export const ShellPageContributionSchema = Schema.Struct({
  componentKey: stableKey,
  contributionKey: stableKey,
  entrypoint: pageEntrypoint,
});

export const ShellPublicComponentContributionSchema = Schema.Struct({
  componentKey: stableKey,
  contributionKey: stableKey,
  entrypoint: componentEntrypoint,
});

export const ShellSearchContributionSchema = Schema.Struct({
  contributionKey: stableKey,
  entrypoint: searchEntrypoint,
  searchKey: stableKey,
});

export const ShellResourceDetailContributionSchema = Schema.Struct({
  apiKey: stableKey,
  contributionKey: stableKey,
  entrypoint: readableApiEntrypoint,
  resourceType: stableKey,
});

export const ShellTimelineContributionSchema = Schema.Struct({
  apiKey: stableKey,
  contributionKey: stableKey,
  entrypoint: readableApiEntrypoint,
  resourceType: stableKey,
});

export const ShellReportContributionSchema = Schema.Struct({
  contributionKey: stableKey,
  entrypoint: reportEntrypoint,
  reportKey: stableKey,
});

export const ShellMediaAttachmentContributionSchema = Schema.Struct({
  actionKey: stableKey,
  apiKey: stableKey,
  contributionKey: stableKey,
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

const unique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`duplicate ${label}`);
  }
};

const requireReference = (set: ReadonlySet<string>, key: string, label: string): void => {
  if (!set.has(key)) {
    throw new TypeError(`${label} references undeclared manifest key ${key}`);
  }
};

export const validateShellContributions = (
  input: unknown,
  references: ShellContributionReferenceSets,
): OntosShellContributions => {
  const contributions = Schema.decodeUnknownSync(OntosShellContributionsSchema, {
    onExcessProperty: 'error',
  })(input);
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
  unique(
    all.map(({ contributionKey }) => contributionKey),
    'Shell contribution key',
  );
  for (const contribution of all) {
    if (
      contribution.entrypoint.moduleKey !== references.moduleId ||
      !contribution.entrypoint.entrypointKey.startsWith(`${references.moduleId}.`)
    ) {
      throw new TypeError('Shell contribution entrypoint owner must match the manifest module');
    }
  }
  for (const contribution of contributions.navigation) {
    requireReference(
      new Set(contributions.pages.map(({ contributionKey }) => contributionKey)),
      contribution.pageKey,
      'navigation contribution',
    );
  }
  for (const contribution of [...contributions.pages, ...contributions.publicComponents]) {
    requireReference(references.componentKeys, contribution.componentKey, 'component contribution');
  }
  for (const contribution of contributions.search) {
    requireReference(references.searchKeys, contribution.searchKey, 'search contribution');
  }
  for (const contribution of contributions.reports) {
    requireReference(references.reportKeys, contribution.reportKey, 'report contribution');
  }
  for (const contribution of [...contributions.resourceDetails, ...contributions.timelines]) {
    requireReference(references.apiKeys, contribution.apiKey, 'resource contribution');
    requireReference(
      references.resourceTypeKeys,
      contribution.resourceType,
      'resource contribution',
    );
  }
  for (const contribution of contributions.mediaAttachments) {
    requireReference(references.actionKeys, contribution.actionKey, 'media contribution');
    requireReference(references.apiKeys, contribution.apiKey, 'media contribution');
    requireReference(references.resourceTypeKeys, contribution.resourceType, 'media contribution');
  }
  return contributions;
};
