// @effect-diagnostics asyncFunction:off
export interface CoreReferenceContext {
  readonly principalId: string;
  readonly tenantId: string;
}

export type CoreReferenceKind = 'mention' | 'relation';

export interface CoreReference {
  readonly entityId: string;
  readonly entityType: string;
  readonly kind: CoreReferenceKind;
  readonly lastResolvedLabel: string;
  readonly ownerModuleKey: string;
  readonly targetTenantId: string;
  readonly token: string;
}

export type CoreReferenceSource =
  | { readonly type: 'deepLink'; readonly value: string }
  | { readonly type: 'opaqueToken'; readonly value: string };

export interface CoreReferenceProviderCandidate {
  readonly entityId: string;
  readonly entityType: string;
  readonly label: string;
  readonly targetTenantId: string;
  readonly token: string;
}

export interface CoreReferenceProviderTarget extends CoreReferenceProviderCandidate {
  readonly openRequest: unknown;
}

export interface CoreReferenceNavigation {
  readonly href: string;
}

export interface CoreReferenceProvider {
  readonly authorizeOpen: (input: {
    readonly context: CoreReferenceContext;
    readonly openRequest: unknown;
    readonly reference: CoreReference;
  }) => boolean | Promise<boolean>;
  readonly discover: (input: {
    readonly context: CoreReferenceContext;
    readonly query: string;
  }) =>
    | readonly CoreReferenceProviderCandidate[]
    | Promise<readonly CoreReferenceProviderCandidate[]>;
  readonly moduleKey: string;
  readonly open: (input: {
    readonly context: CoreReferenceContext;
    readonly openRequest: unknown;
    readonly reference: CoreReference;
  }) => CoreReferenceNavigation | Promise<CoreReferenceNavigation | undefined> | undefined;
  readonly recognize: (input: {
    readonly context: CoreReferenceContext;
    readonly source: CoreReferenceSource;
  }) => CoreReferenceProviderCandidate | null | Promise<CoreReferenceProviderCandidate | null>;
  readonly resolve: (input: {
    readonly context: CoreReferenceContext;
    readonly reference: CoreReference;
  }) => CoreReferenceProviderTarget | null | Promise<CoreReferenceProviderTarget | null>;
}

export interface DiscoveredCoreReference extends CoreReferenceProviderCandidate {
  readonly ownerModuleKey: string;
}

export type CoreReferenceInsertionResult =
  | { readonly _tag: 'CoreReferenceInserted'; readonly reference: CoreReference }
  | {
      readonly _tag: 'CoreReferenceRejected';
      readonly code: 'ambiguous_reference' | 'invalid_source' | 'unknown_reference';
    };

export type CoreReferenceResolutionResult =
  | { readonly _tag: 'CoreReferenceActive'; readonly reference: CoreReference }
  | { readonly _tag: 'CoreReferenceFallback'; readonly reference: CoreReference };

export type CoreReferenceOpenResult =
  | { readonly _tag: 'CoreReferenceOpened'; readonly href?: string | undefined }
  | { readonly _tag: 'CoreReferenceOpenDenied' }
  | { readonly _tag: 'CoreReferenceOpenUnavailable' };

export interface CoreReferenceRegistry {
  readonly discover: (input: {
    readonly context: CoreReferenceContext;
    readonly query: string;
  }) => Promise<readonly DiscoveredCoreReference[]>;
  readonly insert: (input: {
    readonly context: CoreReferenceContext;
    readonly kind: CoreReferenceKind;
    readonly source: CoreReferenceSource;
  }) => Promise<CoreReferenceInsertionResult>;
  readonly open: (input: {
    readonly context: CoreReferenceContext;
    readonly reference: CoreReference;
  }) => Promise<CoreReferenceOpenResult>;
  readonly register: (provider: CoreReferenceProvider) => () => void;
  readonly resolve: (input: {
    readonly context: CoreReferenceContext;
    readonly reference: CoreReference;
  }) => Promise<CoreReferenceResolutionResult>;
}

const nonEmpty = (value: string): boolean => value.trim().length > 0;

const validCandidate = (target: CoreReferenceProviderCandidate): boolean =>
  [target.entityId, target.entityType, target.label, target.targetTenantId, target.token].every(
    nonEmpty,
  );

const targetMatchesReference = (
  target: CoreReferenceProviderTarget,
  reference: CoreReference,
): boolean =>
  validCandidate(target) &&
  target.entityId === reference.entityId &&
  target.entityType === reference.entityType &&
  target.targetTenantId === reference.targetTenantId &&
  target.token === reference.token;

const referenceIdentityKey = (reference: CoreReference): string =>
  JSON.stringify([
    reference.ownerModuleKey,
    reference.targetTenantId,
    reference.entityType,
    reference.entityId,
    reference.token,
  ]);

export const createCoreReferenceRegistry = (
  providers: readonly CoreReferenceProvider[] = [],
): CoreReferenceRegistry => {
  const providerByModuleKey = new Map(providers.map((provider) => [provider.moduleKey, provider]));
  const lastResolvedReferenceByIdentity = new Map<string, CoreReference>();
  const resolveTarget = async (input: {
    readonly context: CoreReferenceContext;
    readonly reference: CoreReference;
  }) => {
    const referenceProvider = providerByModuleKey.get(input.reference.ownerModuleKey);
    if (referenceProvider === undefined) {
      return null;
    }
    let target: CoreReferenceProviderTarget | null;
    try {
      target = await referenceProvider.resolve(input);
    } catch {
      return null;
    }
    return target !== null && targetMatchesReference(target, input.reference)
      ? { referenceProvider, target }
      : null;
  };

  return {
    discover: async ({ context, query }) => {
      const discovered = await Promise.all(
        [...providerByModuleKey.values()].map(async (referenceProvider) => {
          const targets = await referenceProvider.discover({ context, query });
          return targets.filter(validCandidate).map((target) => ({
            entityId: target.entityId,
            entityType: target.entityType,
            label: target.label,
            ownerModuleKey: referenceProvider.moduleKey,
            targetTenantId: target.targetTenantId,
            token: target.token,
          }));
        }),
      );
      return discovered.flat();
    },
    insert: async (input) => {
      if (
        (input.source.type !== 'deepLink' && input.source.type !== 'opaqueToken') ||
        !nonEmpty(input.source.value)
      ) {
        return { _tag: 'CoreReferenceRejected', code: 'invalid_source' };
      }

      const recognitionResults = await Promise.all(
        [...providerByModuleKey.values()].map(async (referenceProvider) => {
          const target = await referenceProvider.recognize({
            context: input.context,
            source: input.source,
          });
          return target === null || !validCandidate(target) ? null : { referenceProvider, target };
        }),
      );
      const recognized = recognitionResults.filter((result) => result !== null);
      if (recognized.length === 0) {
        return { _tag: 'CoreReferenceRejected', code: 'unknown_reference' };
      }
      if (recognized.length > 1) {
        return { _tag: 'CoreReferenceRejected', code: 'ambiguous_reference' };
      }

      const [match] = recognized;
      if (match === undefined) {
        return { _tag: 'CoreReferenceRejected', code: 'unknown_reference' };
      }
      const { referenceProvider, target } = match;
      const reference: CoreReference = {
        entityId: target.entityId,
        entityType: target.entityType,
        kind: input.kind,
        lastResolvedLabel: target.label,
        ownerModuleKey: referenceProvider.moduleKey,
        targetTenantId: target.targetTenantId,
        token: target.token,
      };
      lastResolvedReferenceByIdentity.set(referenceIdentityKey(reference), reference);
      return {
        _tag: 'CoreReferenceInserted',
        reference,
      };
    },
    open: async (input) => {
      const resolved = await resolveTarget(input);
      if (resolved === null) {
        return { _tag: 'CoreReferenceOpenUnavailable' };
      }
      const authorized = await resolved.referenceProvider.authorizeOpen({
        ...input,
        openRequest: resolved.target.openRequest,
      });
      if (!authorized) {
        return { _tag: 'CoreReferenceOpenDenied' };
      }
      const navigation = await resolved.referenceProvider.open({
        ...input,
        openRequest: resolved.target.openRequest,
      });
      return {
        _tag: 'CoreReferenceOpened',
        ...(typeof navigation === 'object' &&
        navigation !== null &&
        'href' in navigation &&
        typeof navigation.href === 'string'
          ? { href: navigation.href }
          : {}),
      };
    },
    register: (provider) => {
      if (providerByModuleKey.has(provider.moduleKey)) {
        throw new Error(`Core Reference provider already registered: ${provider.moduleKey}`);
      }
      providerByModuleKey.set(provider.moduleKey, provider);
      return () => {
        if (providerByModuleKey.get(provider.moduleKey) === provider) {
          providerByModuleKey.delete(provider.moduleKey);
        }
      };
    },
    resolve: async (input) => {
      const resolved = await resolveTarget(input);
      if (resolved === null) {
        return {
          _tag: 'CoreReferenceFallback',
          reference:
            lastResolvedReferenceByIdentity.get(referenceIdentityKey(input.reference)) ??
            input.reference,
        };
      }
      const reference = { ...input.reference, lastResolvedLabel: resolved.target.label };
      lastResolvedReferenceByIdentity.set(referenceIdentityKey(reference), reference);
      return { _tag: 'CoreReferenceActive', reference };
    },
  };
};

export const coreReferenceRegistry = createCoreReferenceRegistry();

export const registerCoreReferenceProvider = (provider: CoreReferenceProvider): (() => void) =>
  coreReferenceRegistry.register(provider);
