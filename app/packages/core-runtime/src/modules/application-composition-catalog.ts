import { Effect, Redacted, Schema } from 'effect';

import {
  ApplicationCompositionSchema,
  ApplicationCompositionValidationError,
  canonicalizeApplicationComposition,
  freezeApplicationCompositionArtifact,
  ONTOS_APPLICATION_COMPOSITION_MAX_BYTES,
  ONTOS_APPLICATION_COMPOSITION_MAX_CONTRACT_BYTES,
  ONTOS_APPLICATION_COMPOSITION_VALIDATION_TIMEOUT_MS,
  validateApplicationCompositionCandidate,
} from './application-composition.ts';
import type { ApplicationComposition, ApplicationCompositionCandidateEvidence } from './application-composition.ts';
import { buildInstalledModuleCatalog } from './catalog.ts';
import type { InstalledModuleCatalog } from './catalog.ts';
import { ONTOS_MODULE_CONTRACT_MAX_BYTES, OntosModuleDeploymentContractSchema } from './manifest.ts';
import { shellPageRouteCatalogIssue } from './shell-contribution.ts';

const utf8 = new TextEncoder();
const contractJsonSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);

const invalid = (reason: string, cause?: unknown): ApplicationCompositionValidationError => {
  if (cause === undefined) {
    return new ApplicationCompositionValidationError({ reason });
  }
  return new ApplicationCompositionValidationError({ cause: Redacted.make(cause), reason });
};

const sha256Hex = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    catch: (cause) => invalid('Application Composition content digest could not be verified', cause),
    try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, 'SHA-256', bytes),
  }).pipe(
    Effect.map((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
    Effect.timeoutOrElse({
      duration: ONTOS_APPLICATION_COMPOSITION_VALIDATION_TIMEOUT_MS,
      orElse: () => Effect.fail(invalid('Application Composition validation exceeded its time budget')),
    }),
  );

/** The immutable revision includes the exact contract source, not a parsed/re-encoded approximation. */
export const applicationCompositionContentRevision = (composition: ApplicationComposition) =>
  sha256Hex(utf8.encode(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })));

const buildCatalog = Effect.fn('ApplicationComposition.buildCatalog')(function* buildCatalog(
  input: ApplicationComposition,
) {
  const composition = yield* Schema.decodeEffect(ApplicationCompositionSchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError((cause) => invalid('Application Composition does not match the supported schema', cause)),
  );
  let totalContractBytes = 0;
  const decoded = yield* Effect.forEach(
    composition.modules,
    Effect.fnUntraced(function* decodeModule(module) {
      if (module.contractDocument.length > ONTOS_MODULE_CONTRACT_MAX_BYTES) {
        return yield* invalid('Application Composition exceeds its complete contract byte budget');
      }
      const bytes = utf8.encode(module.contractDocument);
      totalContractBytes += bytes.byteLength;
      if (
        bytes.byteLength > ONTOS_MODULE_CONTRACT_MAX_BYTES ||
        totalContractBytes > ONTOS_APPLICATION_COMPOSITION_MAX_CONTRACT_BYTES
      ) {
        return yield* invalid('Application Composition exceeds its complete contract byte budget');
      }
      if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== module.contractDocument) {
        return yield* invalid(`module ${module.moduleId} contract document is not exact UTF-8 text`);
      }
      const digest = yield* sha256Hex(bytes);
      if (digest !== module.contract.sha256 || digest !== module.publicContract.sha256) {
        return yield* invalid(`module ${module.moduleId} contract document digest does not match its pinned artifact`);
      }
      const contract = yield* Schema.decodeEffect(contractJsonSchema, { onExcessProperty: 'error' })(
        module.contractDocument,
      ).pipe(
        Effect.mapError((cause) =>
          invalid(`module ${module.moduleId} contract document is invalid or unsupported`, cause),
        ),
      );
      const contributionKeys = Object.values(contract.manifest.publicSurface.shellContributions).flatMap(
        (contributions) => contributions.map(({ contributionKey }) => contributionKey),
      );
      const { components } = contract.manifest.publicSurface;
      const componentByKey = new Map(components.map((component) => [component.key, component]));
      if (componentByKey.size !== components.length) {
        return yield* invalid(`module ${module.moduleId} contract declares duplicate component identities`);
      }
      const contributions = contract.manifest.publicSurface.shellContributions;
      for (const contribution of [...contributions.pages, ...contributions.publicComponents]) {
        if (componentByKey.get(contribution.componentKey)?.expose !== contribution.expose) {
          return yield* invalid(`module ${module.moduleId} contribution does not match its component expose`);
        }
      }
      const boundaries = new Set(components.map(({ mfBoundaryId }) => mfBoundaryId));
      if (boundaries.size > 1) {
        return yield* invalid(`module ${module.moduleId} contract declares multiple Module Federation boundaries`);
      }
      const [component] = components;
      const evidence = {
        contractUrl: module.contract.url,
        contributionKeys,
        deployment: contract.deployment,
        federationExposes: components.map(({ expose }) => expose),
        moduleId: contract.manifest.module.id,
        publicContract: { id: contract.manifest.module.id, sha256: digest, version: contract.schemaVersion },
        sha256: digest,
      };
      return {
        contract,
        evidence: component === undefined ? evidence : { ...evidence, mfBoundaryId: component.mfBoundaryId },
        module,
      };
    }),
    { concurrency: 1 },
  );
  const routeIssue = shellPageRouteCatalogIssue(
    decoded.flatMap(({ contract }) => contract.manifest.publicSurface.shellContributions.pages),
  );
  if (routeIssue !== undefined) {
    return yield* invalid(routeIssue);
  }
  const canonicalBytes = utf8.encode(canonicalizeApplicationComposition(composition));
  if (canonicalBytes.byteLength > ONTOS_APPLICATION_COMPOSITION_MAX_BYTES) {
    return yield* invalid('Application Composition exceeds its encoded byte budget');
  }
  if ((yield* applicationCompositionContentRevision(composition)) !== composition.revision) {
    return yield* invalid('Application Composition revision does not match its immutable content');
  }
  const evidence: ApplicationCompositionCandidateEvidence = {
    backends: Object.fromEntries(composition.modules.map(({ backend, deployment }) => [deployment.appId, backend])),
    contracts: Object.fromEntries(
      decoded.map(({ evidence: observation }) => [observation.deployment.appId, observation]),
    ),
    // URLs are validated by the publisher against its trusted environment before admission. Here,
    // allowing loopback preserves the same provider-neutral bundle codec on development runtimes.
    environment: 'development',
    federationManifests: Object.fromEntries(
      composition.modules.flatMap((module) =>
        module.federation.execution === 'browser'
          ? [
              [
                module.federation.manifest.url,
                {
                  exposes: module.federation.exposes,
                  remoteName: module.federation.remoteName,
                  sha256: module.federation.manifest.sha256,
                  sharedSingletons: module.sharedSingletons,
                },
              ],
            ]
          : [],
      ),
    ),
    runtime: composition.shell,
  };
  yield* validateApplicationCompositionCandidate(composition, evidence);
  const catalog = yield* Effect.try({
    catch: (cause) => invalid('Application Composition contracts do not form one complete installed catalog', cause),
    try: () =>
      buildInstalledModuleCatalog(
        decoded.map(({ contract, module }) => ({
          contract,
          expectedAppId: module.deployment.appId,
        })),
      ),
  });
  // Catalog accessors refer to these same decoded contracts. Freeze those contracts as well as
  // the catalog containers: an accepted revision must not change through a returned projection.
  for (const contract of catalog.contracts) {
    freezeApplicationCompositionArtifact(contract);
  }
  return catalog;
});

/**
 * Construct one all-or-nothing catalog from approved documents. No remote fetch, topology fallback,
 * availability filtering, or retained last-known-good catalog can alter installed membership.
 */
export const buildApplicationCompositionCatalog = (
  composition: ApplicationComposition,
): Effect.Effect<InstalledModuleCatalog, ApplicationCompositionValidationError> =>
  buildCatalog(composition).pipe(
    Effect.timeoutOrElse({
      duration: ONTOS_APPLICATION_COMPOSITION_VALIDATION_TIMEOUT_MS,
      orElse: () => Effect.fail(invalid('Application Composition validation exceeded its time budget')),
    }),
  );
