import { Array as EffectArray, Effect, FileSystem, Option, Schema } from 'effect';
import { SyntaxKind } from '@typescript/native/unstable/ast';
import {
  GOVERNED_HTTP_API_ADDITION_SLOT_END,
  GOVERNED_HTTP_API_ADDITION_SLOT_START,
  GOVERNED_HTTP_API_IMPORT_SLOT_END,
  GOVERNED_HTTP_API_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_IMPORT_SLOT_END,
  GOVERNED_HTTP_HANDLER_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_END,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
  MODULE_MANIFEST_API_SLOT_END,
  MODULE_MANIFEST_API_SLOT_START,
  MODULE_MANIFEST_COMPONENT_SLOT_END,
  MODULE_MANIFEST_COMPONENT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_REPORT_SLOT_END,
  MODULE_MANIFEST_REPORT_SLOT_START,
  MODULE_MANIFEST_SEARCH_SLOT_END,
  MODULE_MANIFEST_SEARCH_SLOT_START,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_END,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_START,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_END,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_START,
  MODULE_REGISTRATION_API_SLOT_END,
  MODULE_REGISTRATION_API_SLOT_START,
  MODULE_REGISTRATION_COMPONENT_SLOT_END,
  MODULE_REGISTRATION_COMPONENT_SLOT_START,
  MODULE_REGISTRATION_REPORT_SLOT_END,
  MODULE_REGISTRATION_REPORT_SLOT_START,
  MODULE_REGISTRATION_SEARCH_SLOT_END,
  MODULE_REGISTRATION_SEARCH_SLOT_START,
  createOrAcceptGeneratedMutationEffect,
  createMutationEffect,
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  generatedSlotContainsExactEntry,
  insertSortedSlot,
  insertModuleFederationExposure,
  isModuleManifestImport,
  raiseScaffoldFailure,
  readGeneratedSlotEntries,
  requireCanonicalSlug,
  resolveContainedPath,
  scaffoldFailure,
  toCamelCase,
  toPascalCase,
  toTitle,
  tryScaffold,
  updateMutation,
  withExactDependencies,
} from '../shared.mts';
import { hasGeneratedGovernedServerContract } from '../../generated-governed-http-boundary.mts';
import { planActionBoundaryScaffold } from '../microvertical-action-boundary/scaffold.mts';
import {
  hasGeneratedOperationGatewayContract,
  hasGeneratedGovernedClientContract,
  hasGeneratedModuleApiReadContract,
  hasGeneratedModuleApiContract,
  hasNamedImportBinding,
  hasGeneratedProviderApiContract,
  hasGeneratedProviderReadContract,
  hasGeneratedOperationPrincipalContract,
  hasUniqueExactNamedImport,
  tokenizeGovernedClient,
} from '../../generated-module-api-boundary.mts';
import type {
  GovernedContributionScaffoldConfig,
  Mutation,
  OntosVerticalMetadata,
  ScaffoldFailure,
} from '../shared.mts';
import { hasValidGovernedHttpCompositionRoot } from '../../generated-governed-http-boundary.mts';

const MODULE_API_KIND = 'module-api';
const PUBLIC_COMPONENT_KIND = 'public-component';
const REPORT_KIND = 'report';
const SEARCH_PROVIDER_KIND = 'search-provider';

const GovernedContributionKindSchema = Schema.Literals([
  MODULE_API_KIND,
  PUBLIC_COMPONENT_KIND,
  REPORT_KIND,
  SEARCH_PROVIDER_KIND,
]);
export type GovernedContributionKind = typeof GovernedContributionKindSchema.Type;

const ProviderContributionKindSchema = Schema.Literals([REPORT_KIND, SEARCH_PROVIDER_KIND]);
type ProviderContributionKind = typeof ProviderContributionKindSchema.Type;
const isProviderContribution = Schema.is(ProviderContributionKindSchema);

const directTokenStringProperty = (
  tokens: ReturnType<typeof tokenizeGovernedClient>,
  property: string,
): string | undefined => {
  const identities: string[] = [];
  let braceDepth = 0;
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (
      braceDepth === 1 &&
      tokens[index]?.kind === SyntaxKind.Identifier &&
      tokens[index]?.value === property &&
      tokens[index + 1]?.kind === SyntaxKind.ColonToken &&
      tokens[index + 2]?.kind === SyntaxKind.StringLiteral
    ) {
      const identity = tokens[index + 2]?.value;
      if (identity !== undefined) {
        identities.push(identity);
      }
    }
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
  }
  return identities.length === 1 ? identities[0] : undefined;
};

const slotEntryIdentity = (source: string): string | undefined => {
  const tokens = tokenizeGovernedClient(source);
  const [registrationProperty, registrationColon] = tokens;
  if (
    registrationColon?.kind === SyntaxKind.ColonToken &&
    (registrationProperty?.kind === SyntaxKind.StringLiteral ||
      registrationProperty?.kind === SyntaxKind.Identifier)
  ) {
    return registrationProperty.value;
  }
  for (const property of ['contributionKey', 'key']) {
    const identity = directTokenStringProperty(tokens, property);
    if (identity !== undefined) {
      return identity;
    }
  }
  return undefined;
};

const readStringArray = (
  tokens: ReturnType<typeof tokenizeGovernedClient>,
  start: number,
): readonly string[] | undefined => {
  const values: string[] = [];
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token?.kind === SyntaxKind.CloseBracketToken) {
      return values;
    }
    if (token?.kind === SyntaxKind.StringLiteral) {
      values.push(token.value);
    } else if (token?.kind !== SyntaxKind.CommaToken) {
      return undefined;
    }
  }
  return undefined;
};

const directStringProperty = (source: string, property: string): string | undefined =>
  directTokenStringProperty(tokenizeGovernedClient(source), property);

const directStringArrayProperty = (
  source: string,
  property: string,
): readonly string[] | undefined => {
  const tokens = tokenizeGovernedClient(source);
  let braceDepth = 0;
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (
      braceDepth === 1 &&
      tokens[index]?.kind === SyntaxKind.Identifier &&
      tokens[index]?.value === property &&
      tokens[index + 1]?.kind === SyntaxKind.ColonToken &&
      tokens[index + 2]?.kind === SyntaxKind.OpenBracketToken
    ) {
      return readStringArray(tokens, index + 3);
    }
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (tokens[index]?.kind === SyntaxKind.CloseBraceToken) {
      braceDepth -= 1;
    }
  }
  return undefined;
};

// Owners may adapt accessFiltering/tenantPermission and report label/dimensions. These describe
// presentation and report shape; the generated provider identity and resource ownership stay fixed.
const acceptsAdaptedProviderDescriptor = (
  start: string,
  current: string,
  expected: string,
): boolean => {
  if (start !== MODULE_MANIFEST_SEARCH_SLOT_START && start !== MODULE_MANIFEST_REPORT_SLOT_START) {
    return false;
  }
  const requiredStringProperties = ['key', 'owningModuleId', 'resourceType'];
  if (
    requiredStringProperties.some(
      (property) =>
        directStringProperty(current, property) !== directStringProperty(expected, property),
    )
  ) {
    return false;
  }
  const expectedResourceTypes = directStringArrayProperty(expected, 'resourceTypes');
  const currentResourceTypes = directStringArrayProperty(current, 'resourceTypes');
  if (
    expectedResourceTypes !== undefined &&
    (currentResourceTypes === undefined ||
      currentResourceTypes.length !== expectedResourceTypes.length ||
      expectedResourceTypes.some((value, index) => currentResourceTypes[index] !== value))
  ) {
    return false;
  }
  const accessFiltering = directStringProperty(current, 'accessFiltering');
  return (
    accessFiltering === 'resource_permission' ||
    (accessFiltering === 'tenant_scope' &&
      directStringProperty(current, 'tenantPermission') !== undefined)
  );
};

const structurallyMatchesGeneratedEntry = (current: string, expected: string): boolean => {
  const currentTokens = tokenizeGovernedClient(current);
  const expectedTokens = tokenizeGovernedClient(expected);
  if (currentTokens.length !== expectedTokens.length) {
    return false;
  }
  return expectedTokens.every((expectedToken, index) => {
    const currentToken = currentTokens[index];
    const isPropertyKey =
      index === 0 &&
      (expectedToken.kind === SyntaxKind.Identifier ||
        expectedToken.kind === SyntaxKind.StringLiteral) &&
      (currentToken?.kind === SyntaxKind.Identifier ||
        currentToken?.kind === SyntaxKind.StringLiteral);
    const sameKind = isPropertyKey || currentToken?.kind === expectedToken.kind;
    const carriesIdentity =
      expectedToken.kind === SyntaxKind.Identifier ||
      expectedToken.kind === SyntaxKind.StringLiteral;
    return sameKind && (!carriesIdentity || currentToken?.value === expectedToken.value);
  });
};

const GENERATED_OWNER_SLOTS = [
  [MODULE_MANIFEST_API_SLOT_START, MODULE_MANIFEST_API_SLOT_END],
  [MODULE_MANIFEST_COMPONENT_SLOT_START, MODULE_MANIFEST_COMPONENT_SLOT_END],
  [MODULE_MANIFEST_REPORT_SLOT_START, MODULE_MANIFEST_REPORT_SLOT_END],
  [MODULE_MANIFEST_SEARCH_SLOT_START, MODULE_MANIFEST_SEARCH_SLOT_END],
  [MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START, MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END],
  [MODULE_MANIFEST_SHELL_REPORT_SLOT_START, MODULE_MANIFEST_SHELL_REPORT_SLOT_END],
  [MODULE_MANIFEST_SHELL_SEARCH_SLOT_START, MODULE_MANIFEST_SHELL_SEARCH_SLOT_END],
  [MODULE_REGISTRATION_API_SLOT_START, MODULE_REGISTRATION_API_SLOT_END],
  [MODULE_REGISTRATION_COMPONENT_SLOT_START, MODULE_REGISTRATION_COMPONENT_SLOT_END],
  [MODULE_REGISTRATION_REPORT_SLOT_START, MODULE_REGISTRATION_REPORT_SLOT_END],
  [MODULE_REGISTRATION_SEARCH_SLOT_START, MODULE_REGISTRATION_SEARCH_SLOT_END],
] as const;

const patchSlots = (content: string, slots: readonly [string, string, string][], ownerSlots: readonly (readonly [string, string])[]): string =>
  slots.reduce((current, [start, end, line]) => {
    const entries = readGeneratedSlotEntries(current, start, end);
    if (entries.some((candidate) => !candidate.endsWith(','))) {
      return raiseScaffoldFailure(
        `generated owner slot contains unsupported developer content: ${start}`,
      );
    }
    const identity = slotEntryIdentity(line);
    const allOwnerEntries = ownerSlots.filter(
      ([ownerStart, ownerEnd]) => current.includes(ownerStart) && current.includes(ownerEnd),
    ).flatMap(([ownerStart, ownerEnd]) =>
      readGeneratedSlotEntries(current, ownerStart, ownerEnd).map((entry) => ({
        entry,
        start: ownerStart,
      })),
    );
    if (allOwnerEntries.some(({ entry }) => slotEntryIdentity(entry) === undefined)) {
      return raiseScaffoldFailure(
        `generated owner slot contains unsupported developer content: ${start}`,
      );
    }
    const identityMatches =
      identity === undefined
        ? []
        : allOwnerEntries.filter(({ entry }) => slotEntryIdentity(entry) === identity);
    if (identityMatches.length > 1) {
      return raiseScaffoldFailure(`generated owner slot contains duplicate identity: ${identity}`);
    }
    if (generatedSlotContainsExactEntry(current, start, end, line)) {
      return current;
    }
    const [identityMatch] = identityMatches;
    if (
      identityMatch !== undefined &&
      identityMatch.start === start &&
      (structurallyMatchesGeneratedEntry(identityMatch.entry, line) ||
        acceptsAdaptedProviderDescriptor(start, identityMatch.entry, line))
    ) {
      return current;
    }
    if (identityMatch !== undefined) {
      return raiseScaffoldFailure(`generated owner slot contains mismatched identity: ${identity}`);
    }
    return insertSortedSlot(current, start, end, [line], (candidate) => candidate.endsWith(','));
  }, content);
/* eslint-enable unicorn/no-array-reduce */

const patchFederationExposure = Effect.fn('GovernedContributionScaffold.patchFederationExposure')(
  function* patchFederationExposure(vertical: OntosVerticalMetadata, name: string) {
    const configPath = yield* tryScaffold('failed to resolve Module Federation config path', () =>
      resolveContainedPath(vertical.directory, 'module-federation.config.ts'),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(
        Effect.mapError((cause) =>
          scaffoldFailure(`failed to read Module Federation config ${configPath}`, cause),
        ),
      );
    const next = yield* tryScaffold('failed to patch Module Federation exposure', () =>
      insertModuleFederationExposure(
        content,
        `./${toPascalCase(name)}`,
        `./src/components/${name}.tsx`,
      ),
    );
    return { content: next, kind: 'update' as const, path: configPath };
  },
);

/* eslint-disable no-nested-ternary, unicorn/no-nested-ternary -- Preserve the compact established generator-name mapping and kind dispatch. */
const acceptsGeneratedClient = (
  kind: GovernedContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
): ((current: string) => boolean) => {
  const type = toPascalCase(name);
  const isModuleApi = kind === MODULE_API_KIND;
  const providerKind = isModuleApi ? undefined : kind === REPORT_KIND ? 'Report' : 'Search';
  const operationStem = isModuleApi ? `execute${type}` : `load${type}Client`;
  const expectedGroups = isModuleApi
    ? [toCamelCase(name)]
    : [kind === REPORT_KIND ? 'reports' : 'search', `${toCamelCase(name)}${providerKind}`];
  return (current) =>
    expectedGroups.some((endpointGroup) =>
      hasGeneratedGovernedClientContract(current, {
        authorizedOperation: `${operationStem}WithAuthorization`,
        defaultApiPrefix: `/${vertical.appId}-api`,
        endpointGroup,
        generatedHeader: `${generatedHeader(kind)}\n`,
        invocationKind: isModuleApi ? 'module-api' : 'provider',
        ownerApiValue: isModuleApi ? `${type}Api` : `${type}${providerKind}Api`,
        ownerContractImport: isModuleApi
          ? `../../shared/apis/${name}.ts`
          : `../../shared/apis/${name}-${kind === REPORT_KIND ? REPORT_KIND : 'search'}.ts`,
        publicOperation: operationStem,
      }),
    );
};

const operationBoundaryPaths = (vertical: OntosVerticalMetadata) => ({
  gatewayPath: `${vertical.directory}/src/api/action-gateway.ts`,
  principalPath: `${vertical.directory}/api/auth/action-principal.ts`,
});

const hasExistingOperationBoundary = (
  vertical: OntosVerticalMetadata,
): Effect.Effect<boolean, ScaffoldFailure, FileSystem.FileSystem> =>
  Effect.gen(function* hasExistingOperationBoundaryEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const { gatewayPath, principalPath } = operationBoundaryPaths(vertical);
    const exists = yield* Effect.all([
      fileSystem.exists(principalPath),
      fileSystem.exists(gatewayPath),
    ]).pipe(
      Effect.mapError((cause) => scaffoldFailure('failed to inspect operation boundary', cause)),
    );
    if (!exists.every(Boolean)) {
      return false;
    }
    const [principal, gateway] = yield* Effect.all([
      fileSystem.readFileString(principalPath),
      fileSystem.readFileString(gatewayPath),
    ]).pipe(
      Effect.mapError((cause) => scaffoldFailure('failed to read operation boundary', cause)),
    );
    const header = `// @generated by OntOS Codesmith MicroVertical Action Boundary v1\n// @ontos-action-boundary-owner ${vertical.appId}\n`;
    return (
      principal.startsWith(header) &&
      hasGeneratedOperationPrincipalContract(principal) &&
      hasGeneratedOperationGatewayContract(gateway, vertical.appId)
    );
  });

const planOperationBoundary = Effect.fn('GovernedContributionScaffold.planOperationBoundary')(
  function* planOperationBoundary(workspaceRoot: string, vertical: OntosVerticalMetadata) {
    if (!(yield* hasExistingOperationBoundary(vertical))) {
      const fileSystem = yield* FileSystem.FileSystem;
      const { gatewayPath, principalPath } = operationBoundaryPaths(vertical);
      const existingBoundaryFiles = yield* Effect.all([
        fileSystem.exists(principalPath),
        fileSystem.exists(gatewayPath),
      ]).pipe(
        Effect.mapError((cause) =>
          scaffoldFailure('failed to inspect operation boundary files', cause),
        ),
      );
      if (existingBoundaryFiles.every(Boolean)) {
        return yield* Effect.fail(
          scaffoldFailure('refusing to overwrite existing business file: operation boundary'),
        );
      }
      const boundary = yield* planActionBoundaryScaffold(workspaceRoot, {
        vertical: vertical.slug,
      });
      return boundary.mutations;
    }
    const dependencyMutation = yield* tryScaffold(
      'failed to ensure governed client dependency',
      () =>
        withExactDependencies(vertical, {
          '@app/shared-contracts': 'workspace:*',
        }),
    );
    return EffectArray.getSomes([Option.fromNullishOr(dependencyMutation)]);
  },
);

const acceptsGovernedArtifact = (
  kind: typeof MODULE_API_KIND | ProviderContributionKind,
  vertical: OntosVerticalMetadata,
  name: string,
  config: Pick<GovernedContributionScaffoldConfig, 'authorization' | 'permission'>,
): ((current: string) => boolean) => {
  if (kind === MODULE_API_KIND) {
    return (current) =>
      current.startsWith(`${generatedHeader(kind)}\n`) &&
      hasGeneratedModuleApiContract(current, `${toPascalCase(name)}Api`, toCamelCase(name), name);
  }
  if (!isProviderContribution(kind)) {
    return () => false;
  }
  return (current) =>
    current.startsWith(`${generatedHeader(kind)}\n`) &&
    hasGeneratedProviderReadContract(
      current,
      vertical.moduleId,
      name,
      kind === REPORT_KIND ? 'report' : 'search',
      readAuthorizationExpectation(config),
    );
};

export const planGovernedContributionScaffold = Effect.fn('GovernedContributionScaffold.plan')(
  function* planGovernedContributionScaffold(
    workspaceRoot: string,
    kind: GovernedContributionKind,
    config: GovernedContributionScaffoldConfig,
  ) {
    const name = yield* tryScaffold('governed contribution name is invalid', () =>
      requireCanonicalSlug(config.name, kind),
    );
    const resource =
      config.resource === undefined
        ? undefined
        : yield* tryScaffold('governed contribution resource is invalid', () =>
            requireCanonicalSlug(config.resource ?? '', 'resource'),
          );
    const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical);
    const isComponent = kind === PUBLIC_COMPONENT_KIND;
    const isApi = kind === MODULE_API_KIND;
    const directory =
      kind === REPORT_KIND ? 'reports' : kind === SEARCH_PROVIDER_KIND ? 'search' : '';
    const artifactPath = yield* tryScaffold('failed to resolve governed contribution path', () =>
      resolveContainedPath(
        vertical.directory,
        ...(isComponent
          ? ['src', 'components', `${name}.tsx`]
          : isApi
            ? ['shared', 'apis', `${name}.ts`]
            : ['src', directory, `${name}.provider.ts`]),
      ),
    );
    const artifact = yield* tryScaffold('failed to render governed contribution', () => {
      if (isComponent) {
        return renderPublicComponent(name);
      }
      if (isApi) {
        return renderApiContract(name);
      }
      if (isProviderContribution(kind)) {
        return renderProvider(kind, vertical, name, config);
      }
      return raiseScaffoldFailure('unsupported governed contribution', kind);
    });
    const artifactMutation = isComponent
      ? Option.some(yield* createMutationEffect(artifactPath, artifact))
      : yield* createOrAcceptGeneratedMutationEffect(
          artifactPath,
          artifact,
          acceptsGovernedArtifact(kind, vertical, name, config),
        );
    const mutations: Mutation[] = EffectArray.getSomes([artifactMutation]);
    if (isApi) {
      const readPath = yield* tryScaffold('failed to resolve governed read path', () =>
        resolveContainedPath(vertical.directory, 'src', 'api', `${name}.read.ts`),
      );
      const readSource = yield* tryScaffold('failed to render governed read', () =>
        renderModuleApiRead(vertical, name, config),
      );
      const readMutation = yield* createOrAcceptGeneratedMutationEffect(
        readPath,
        readSource,
        (current) =>
          current.startsWith(`${generatedHeader(MODULE_API_KIND)}\n`) &&
          hasGeneratedModuleApiReadContract(
            current,
            vertical.moduleId,
            name,
            readAuthorizationExpectation(config),
          ),
      );
      mutations.push(...EffectArray.getSomes([readMutation]));
    }
    let clientPath: string | undefined;
    let serverPath: string | undefined;
    if (kind === MODULE_API_KIND || isProviderContribution(kind)) {
      const suffix = isApi ? 'client' : kind === REPORT_KIND ? 'report-client' : 'search-client';
      clientPath = yield* tryScaffold('failed to resolve governed client path', () =>
        resolveContainedPath(vertical.directory, 'src', 'api', `${name}-${suffix}.ts`),
      );
      const clientMutation = yield* createOrAcceptGeneratedMutationEffect(
        clientPath,
        isApi ? renderApiClient(vertical, name) : renderProviderClient(kind, vertical, name),
        acceptsGeneratedClient(kind, vertical, name),
      );
      mutations.push(...EffectArray.getSomes([clientMutation]));
      if (isProviderContribution(kind)) {
        const providerContractPath = yield* tryScaffold(
          'failed to resolve provider contract path',
          () =>
            resolveContainedPath(
              vertical.directory,
              'shared',
              'apis',
              `${name}-${kind === REPORT_KIND ? REPORT_KIND : 'search'}.ts`,
            ),
        );
        const providerContractMutation = yield* createOrAcceptGeneratedMutationEffect(
          providerContractPath,
          renderProviderApiContract(kind, vertical, name),
          (current) =>
            current.startsWith(`${generatedHeader(kind)}\n`) &&
            hasGeneratedProviderApiContract(
              current,
              `${toPascalCase(name)}${kind === REPORT_KIND ? 'Report' : 'Search'}Api`,
              vertical.moduleId,
              name,
              kind === REPORT_KIND ? 'report' : 'search',
            ),
        );
        mutations.push(...EffectArray.getSomes([providerContractMutation]));
      }
      serverPath = yield* tryScaffold('failed to resolve governed server path', () =>
        resolveContainedPath(
          vertical.directory,
          'api',
          `${name}-${isApi ? 'read' : kind === REPORT_KIND ? REPORT_KIND : 'search'}-server.ts`,
        ),
      );
      const serverMutation = yield* createOrAcceptGeneratedMutationEffect(
        serverPath,
        renderGovernedServer(kind, name),
        (current) =>
          current.startsWith(`${generatedHeader(kind)}\n`) &&
          hasGeneratedGovernedServerContract(current, `${toCamelCase(name)}ReadApiLive`),
      );
      mutations.push(
        ...EffectArray.getSomes([serverMutation]),
        ...(yield* patchGovernedHttpComposition(vertical, kind, name)),
        ...(yield* planOperationBoundary(workspaceRoot, vertical)),
      );
    }
    const ownerImport = manifestImport(kind, name);
    const ownerImportIdentity = manifestImportIdentity(kind, name);
    let manifest = vertical.manifestContent;
    if (
      ownerImport !== undefined &&
      !hasUniqueExactNamedImport(
        manifest,
        ownerImportIdentity.binding,
        ownerImportIdentity.specifier,
      )
    ) {
      if (hasNamedImportBinding(manifest, ownerImportIdentity.binding)) {
        return yield* scaffoldFailure(
          `generated owner import binding conflicts with ${ownerImportIdentity.binding}`,
        );
      }
      manifest = yield* tryScaffold('failed to patch module manifest imports', () =>
        insertSortedSlotIdempotently(
          manifest,
          MODULE_MANIFEST_IMPORT_SLOT_START,
          MODULE_MANIFEST_IMPORT_SLOT_END,
          ownerImport,
          isModuleManifestImport,
        ),
      );
    }
    const slots = yield* tryScaffold('failed to plan governed contribution owner slots', () =>
      slotLine(kind, vertical, name, resource, config),
    );
    const registration = yield* tryScaffold('failed to patch governed contribution slots', () => {
      manifest = patchSlots(manifest, slots.manifest, manifestOwnerSlots);
      return patchSlots(vertical.registrationContent, slots.registration, registrationOwnerSlots);
    });
    const manifestMutation = yield* tryScaffold('failed to update module manifest', () =>
      updateMutation(vertical.manifestPath, vertical.manifestContent, manifest),
    );
    const registrationMutation = yield* tryScaffold('failed to update module registration', () =>
      updateMutation(vertical.registrationPath, vertical.registrationContent, registration),
    );
    if (manifestMutation !== undefined) {
      mutations.push(manifestMutation);
    }
    if (registrationMutation !== undefined) {
      mutations.push(registrationMutation);
    }
    if (isComponent) {
      mutations.push(yield* patchFederationExposure(vertical, name));
    }
    yield* tryScaffold('governed contribution mutation paths are invalid', () =>
      ensureUniqueMutationPaths(mutations),
    );
    const result =
      clientPath === undefined || serverPath === undefined
        ? { artifactPath }
        : { artifactPath, clientPath, serverPath };
    return { mutations, result };
  },
);
/* eslint-enable complexity, no-nested-ternary, unicorn/no-nested-ternary */
