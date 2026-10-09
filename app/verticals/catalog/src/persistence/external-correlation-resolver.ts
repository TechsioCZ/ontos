import { Context, Effect, Layer, Predicate } from 'effect';

import type { CatalogExternalSourceRecordRef } from '../../shared/domain/external-identifier-boundary.ts';
import { resolveCatalogExternalTarget } from '../../shared/domain/external-target-resolution.ts';
import type {
  CatalogExternalCorrelation,
  CatalogExternalDeterministicCandidate,
  CatalogExternalDeterministicRule,
  CatalogExternalTargetRequest,
  CatalogResolvedExternalTarget,
} from '../../shared/domain/external-target-resolution.ts';
import { ExternalCorrelationAmbiguous } from './external-correlation-ambiguous.ts';
import { ExternalCorrelationInvalid } from './external-correlation-invalid.ts';
import { ExternalCorrelationMissingLink } from './external-correlation-missing-link.ts';
import { ExternalCorrelationTargetTypeMismatch } from './external-correlation-target-type-mismatch.ts';
import { ExternalCorrelationUnverifiable } from './external-correlation-unverifiable.ts';

/** Opaque failure raised by the owner-local Connector Registry read; Catalog does not inspect it. */
interface ExternalCorrelationRegistryFailure {
  readonly _tag: string;
}

/**
 * Read-only port onto the owner-local Connector Registry. Catalog consumes the correlations this
 * owner already maintains; it never creates, owns, or stores a competing registry.
 */
export interface ExternalCorrelationRegistryPorts {
  readonly readCorrelations: (payload: {
    readonly sourceRecord: CatalogExternalSourceRecordRef;
  }) => Effect.Effect<readonly CatalogExternalCorrelation[], ExternalCorrelationRegistryFailure>;
}

export interface ExternalCorrelationResolverRules {
  readonly deterministicCandidates?: readonly CatalogExternalDeterministicCandidate[];
  readonly deterministicRules?: readonly CatalogExternalDeterministicRule[];
}

export type ExternalCorrelationResolutionFailure =
  | ExternalCorrelationAmbiguous
  | ExternalCorrelationInvalid
  | ExternalCorrelationMissingLink
  | ExternalCorrelationTargetTypeMismatch
  | ExternalCorrelationUnverifiable;

const noCorrelations: readonly CatalogExternalCorrelation[] = [];

const unavailableRegistry: ExternalCorrelationRegistryPorts = {
  readCorrelations: () => Effect.fail({ _tag: 'ExternalCorrelationRegistryUnavailableProblem' }),
};

const toResolutionEffect = (
  request: CatalogExternalTargetRequest,
  resolution: ReturnType<typeof resolveCatalogExternalTarget>,
): Effect.Effect<CatalogResolvedExternalTarget, ExternalCorrelationResolutionFailure> => {
  if (resolution.status === 'RESOLVED') {
    return Effect.succeed(resolution);
  }
  if (resolution.status === 'MISSING_LINK') {
    return Effect.fail(new ExternalCorrelationMissingLink({ sourceRecord: request.sourceRecord }));
  }
  if (resolution.status === 'AMBIGUOUS') {
    return Effect.fail(
      new ExternalCorrelationAmbiguous({ candidates: resolution.candidates, reason: resolution.reason }),
    );
  }
  if (resolution.status === 'TARGET_TYPE_MISMATCH') {
    return Effect.fail(new ExternalCorrelationTargetTypeMismatch({ reason: resolution.reason }));
  }
  if (resolution.status === 'UNVERIFIABLE') {
    return Effect.fail(new ExternalCorrelationUnverifiable({ reason: resolution.reason }));
  }
  return Effect.fail(new ExternalCorrelationInvalid({ reason: resolution.reason }));
};

/**
 * Resolve one external source record to an exact Catalog target through the Connector Registry
 * owner. Missing link, ambiguity, an inconsistent target type, and an unavailable owner stay
 * distinct; none of them authorizes overwriting an existing Product or creating a new one.
 */
export const makeExternalCorrelationResolver = (
  configuredPorts?: ExternalCorrelationRegistryPorts,
  rules?: ExternalCorrelationResolverRules,
) => {
  const ports = configuredPorts ?? unavailableRegistry;
  return {
    resolve: (
      request: CatalogExternalTargetRequest,
    ): Effect.Effect<CatalogResolvedExternalTarget, ExternalCorrelationResolutionFailure> =>
      ports.readCorrelations({ sourceRecord: request.sourceRecord }).pipe(
        Effect.catchIf(
          (failure) => Predicate.isTagged(failure, 'ExternalCorrelationRegistryNotFoundProblem'),
          () => Effect.succeed(noCorrelations),
          () =>
            Effect.fail(new ExternalCorrelationUnverifiable({ reason: 'The Connector Registry owner is unavailable' })),
        ),
        Effect.flatMap((correlations) =>
          toResolutionEffect(
            request,
            resolveCatalogExternalTarget({
              correlations,
              deterministicCandidates: rules?.deterministicCandidates ?? [],
              deterministicRules: rules?.deterministicRules ?? [],
              request,
            }),
          ),
        ),
      ),
  };
};

export type ExternalCorrelationResolver = ReturnType<typeof makeExternalCorrelationResolver>;

export class CatalogExternalCorrelationResolver extends Context.Service<
  CatalogExternalCorrelationResolver,
  ExternalCorrelationResolver
>()('@app/catalog/persistence/external-correlation-resolver/CatalogExternalCorrelationResolver') {}

const catalogExternalCorrelationResolverLayer = (
  configuredPorts?: ExternalCorrelationRegistryPorts,
  rules?: ExternalCorrelationResolverRules,
) => Layer.succeed(CatalogExternalCorrelationResolver, makeExternalCorrelationResolver(configuredPorts, rules));

export const catalogExternalCorrelationResolverLive = catalogExternalCorrelationResolverLayer();
