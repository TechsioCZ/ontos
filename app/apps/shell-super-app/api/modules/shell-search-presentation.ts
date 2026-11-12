import {
  CORE_SEARCH_PRESENTATION_SCHEMA_VERSION,
  coreShellRouteParameterNames,
  coreSystemSearchPresentationBindingIssue,
} from '@app/core-runtime/search-contract';
import type {
  CoreSearchPresentationBinding,
  CoreSearchPresentationDeclaration,
  CoreSearchPresentationEntry,
  CoreSearchPresentationIssue,
  CoreSystemSearchPresentation,
  CoreSystemSearchPresentationAuthority,
} from '@app/core-runtime/search-contract';
import { corePeopleSystemSearchProvider } from '@app/core-runtime/people/search';
import { Option, Result, Schema } from 'effect';

import { ShellSearchPresentationInventorySchema } from '../../shared/browser-api.ts';
import type { ShellSearchPresentationInventory } from '../../shared/browser-api.ts';
import type { ShellInstalledCatalog } from './installed-module-catalog.ts';

type CapturedContract = ShellInstalledCatalog['contracts'][number];
type CapturedModule = ShellInstalledCatalog['composition']['modules'][number];
type AdmittedSearchBinding = Omit<CoreSearchPresentationBinding, 'compositionRevision'>;
interface CapturedPage {
  readonly ownerModuleId: string;
  readonly pageKey: string;
  readonly routePath: string;
}
interface ResolvedBinding {
  readonly contract: CapturedContract;
  readonly contribution: CapturedContract['manifest']['publicSurface']['shellContributions']['search'][number];
  readonly descriptor: CapturedContract['manifest']['publicSurface']['search'][number];
  readonly module: CapturedModule;
}
interface PresentationInput {
  readonly admitted: readonly AdmittedSearchBinding[];
  readonly catalog: ShellInstalledCatalog;
  readonly compositionRevision: string;
  readonly system?: {
    readonly authority: CoreSystemSearchPresentationAuthority;
    readonly presentation: CoreSystemSearchPresentation;
  };
}

const invalid = (message: string): Result.Result<never, CoreSearchPresentationIssue> =>
  Result.fail({ code: 'binding_mismatch', message });

const resolveBinding = (
  catalog: ShellInstalledCatalog,
  binding: AdmittedSearchBinding,
): Result.Result<ResolvedBinding, CoreSearchPresentationIssue> => {
  if (binding.ownerModuleId === corePeopleSystemSearchProvider.descriptor.owningModuleId) {
    return invalid('A business presentation cannot claim the Core system owner');
  }
  const contracts = catalog.contracts.filter(({ manifest }) => manifest.module.id === binding.ownerModuleId);
  const [contract] = contracts;
  if (contracts.length !== 1 || contract === undefined || contract.manifest.module.kind !== 'business_module') {
    return invalid('Search presentation requires one captured business owner');
  }
  const modules = catalog.composition.modules.filter(
    (module) => module.moduleId === binding.ownerModuleId && module.deployment.appId === contract.deployment.appId,
  );
  const [module] = modules;
  const descriptors = contract.manifest.publicSurface.search.filter(
    (descriptor) =>
      descriptor.key === binding.searchKey &&
      descriptor.owningModuleId === binding.ownerModuleId &&
      descriptor.resourceType === binding.resourceType,
  );
  const resources = contract.manifest.publicSurface.resourceTypes.filter(
    (resource) => resource.key === binding.resourceType && resource.owningModuleId === binding.ownerModuleId,
  );
  const contributions = contract.manifest.publicSurface.shellContributions.search.filter(
    (contribution) =>
      contribution.searchKey === binding.searchKey && contribution.entrypoint.moduleKey === binding.ownerModuleId,
  );
  const [descriptor] = descriptors;
  const [contribution] = contributions;
  if (
    modules.length !== 1 ||
    module === undefined ||
    descriptors.length !== 1 ||
    descriptor === undefined ||
    resources.length !== 1 ||
    contributions.length !== 1 ||
    contribution === undefined ||
    !module.allowedContributions.includes(contribution.contributionKey)
  ) {
    return invalid('Search presentation does not match its declared owner, resource and search contribution');
  }
  return Result.succeed({ contract, contribution, descriptor, module });
};

const resolvePage = (
  binding: ResolvedBinding,
  pageKey: string,
  presentation: CoreSearchPresentationDeclaration,
): Result.Result<CapturedPage, CoreSearchPresentationIssue> => {
  const { contract, module } = binding;
  const ownerModuleId = contract.manifest.module.id;
  const candidates = contract.manifest.publicSurface.shellContributions.pages.filter(
    (page) => page.contributionKey === pageKey && page.entrypoint.moduleKey === ownerModuleId,
  );
  const [page] = candidates;
  if (candidates.length !== 1 || page === undefined || !module.allowedContributions.includes(page.contributionKey)) {
    return invalid('Search presentation names an undeclared or foreign page');
  }
  if (
    page.routePath === corePeopleSystemSearchProvider.navigationPath ||
    page.routePath.startsWith(`${corePeopleSystemSearchProvider.navigationPath}/`)
  ) {
    return invalid('A business presentation cannot claim a Core-native destination');
  }
  const { federation } = module;
  if (federation.execution !== 'browser') {
    return invalid('Search presentation page has no captured browser exposure');
  }
  const components = contract.manifest.publicSurface.components.filter(
    (component) =>
      component.key === page.componentKey &&
      component.expose === page.expose &&
      component.mfBoundaryId === federation.remoteName,
  );
  if (components.length !== 1 || !federation.exposes.includes(page.expose)) {
    return invalid('Search presentation page is not exposed by its captured owner');
  }
  const parameters = coreShellRouteParameterNames(page.routePath);
  if ((presentation.agendaPageKeys ?? []).includes(pageKey) && parameters.length !== 0) {
    return invalid('Search presentation agenda requires a page without record parameters');
  }
  const selector = presentation.record?.pageKey === pageKey ? presentation.record.selector : undefined;
  if (
    selector?.kind === 'path'
      ? parameters.length !== 1 || parameters[0] !== selector.parameterName
      : parameters.length !== 0
  ) {
    return invalid('Search presentation selector does not bind the exact declared page parameters');
  }
  return Result.succeed({ ownerModuleId, pageKey, routePath: page.routePath });
};

/**
 * The presentation and resolved pages of one admitted owner binding, or none when the owner declares none or its
 * declaration does not match the captured contract. Genuinely generic providers never acquire an owner destination.
 */
const ownerPresentation = (catalog: ShellInstalledCatalog, binding: PresentationInput['admitted'][number]) => {
  const resolved = resolveBinding(catalog, binding);
  if (Result.isFailure(resolved)) {
    return Option.none();
  }
  const { contribution, descriptor } = resolved.success;
  const { presentation } = contribution;
  if (
    presentation === undefined ||
    presentation.scope !== (descriptor.accessFiltering === 'tenant_scope' ? 'tenant' : 'company')
  ) {
    return Option.none();
  }
  const pageKeys = new Set([
    ...(presentation.agendaPageKeys ?? []),
    ...(presentation.record === undefined ? [] : [presentation.record.pageKey]),
  ]);
  const pages: (readonly [string, CapturedPage])[] = [];
  for (const pageKey of pageKeys) {
    const page = resolvePage(resolved.success, pageKey, presentation);
    if (Result.isFailure(page)) {
      return Option.none();
    }
    pages.push([pageKey, page.success]);
  }
  return Option.some({ pages, presentation });
};

/**
 * Compile only providers already admitted by the governed read. This performs no permission check and grants none:
 * the caller retains current tenant/company/module/record authorization. All routes come from the captured release.
 */
export const compileShellSearchPresentation = ({
  admitted,
  catalog,
  compositionRevision,
  system,
}: PresentationInput): Result.Result<ShellSearchPresentationInventory, CoreSearchPresentationIssue> => {
  if (compositionRevision !== catalog.composition.revision) {
    return invalid('Search presentation revision differs from the captured composition');
  }
  const entries: CoreSearchPresentationEntry[] = [];
  const pages = new Map<string, CapturedPage>();
  const claimed = new Set<string>();
  for (const binding of admitted) {
    const bindingKey = `${binding.ownerModuleId}:${binding.searchKey}`;
    if (claimed.has(bindingKey)) {
      return invalid('Search presentation provider binding is ambiguous');
    }
    claimed.add(bindingKey);
    // One owner's misdeclared presentation degrades only that owner to the generic Shell group; it never takes
    // the whole answer down. The owner's hits stay authorized by the owner and open the generic record page.
    const owner = ownerPresentation(catalog, binding);
    if (Option.isSome(owner)) {
      for (const [pageKey, page] of owner.value.pages) {
        pages.set(`${binding.ownerModuleId}:${pageKey}`, page);
      }
      entries.push({ ...binding, presentation: owner.value.presentation });
    }
  }
  if (system !== undefined) {
    const issue = coreSystemSearchPresentationBindingIssue(system.presentation, system.authority);
    if (issue !== undefined) {
      return Result.fail(issue);
    }
  }
  const business = { compositionRevision, entries, schemaVersion: CORE_SEARCH_PRESENTATION_SCHEMA_VERSION };
  const resolvedPages = [...pages.values()];
  const inventory =
    system === undefined
      ? { business, pages: resolvedPages }
      : { business, pages: resolvedPages, system: system.presentation };
  const decoded = Schema.decodeUnknownResult(ShellSearchPresentationInventorySchema, { onExcessProperty: 'error' })(
    inventory,
  );
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail({ code: 'catalog_invalid', message: 'Search presentation inventory is malformed or inconsistent' });
};
