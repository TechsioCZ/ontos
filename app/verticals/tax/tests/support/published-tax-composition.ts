import {
  ApplicationCompositionSingletonSchema,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  applicationCompositionContentRevision,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { ApplicationComposition } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Crypto, DateTime, Duration, Effect, FileSystem, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { createTaxRuleAction } from '../../src/actions/create-tax-rule.action.ts';

class TaxProductionRuntimeFixtureUnavailable extends Schema.TaggedError<TaxProductionRuntimeFixtureUnavailable>()(
  'TaxProductionRuntimeFixtureUnavailable',
  { stage: Schema.Literals(['owner_artifact', 'unit_placement']) },
) {}

/** Exact published owner/Shell bytes; backend placement remains declared scripted unit infrastructure. */
export const publishedTaxComposition = Effect.gen(function* publishedTaxComposition() {
  const filesystem = yield* FileSystem.FileSystem;
  const contractBytes = yield* filesystem.readFile(
    new URL('../../.output/public/.well-known/ontos-module-manifest.json', import.meta.url).pathname,
  );
  const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    new TextDecoder().decode(contractBytes),
  );
  if (
    contract.deployment.appId !== ultramodernDeliveryUnit.appId ||
    contract.manifest.module.id !== createTaxRuleAction.descriptor.entrypoint.moduleKey
  ) {
    return yield* new TaxProductionRuntimeFixtureUnavailable({ stage: 'owner_artifact' });
  }
  const infrastructure = yield* makeApplicationCompositionSnapshotFixture(
    [contract.deployment.appId],
    contract.deployment.buildMarker,
  );
  const [unitPlacement] = infrastructure.composition.modules;
  if (unitPlacement === undefined) {
    return yield* new TaxProductionRuntimeFixtureUnavailable({ stage: 'unit_placement' });
  }
  const shellRuntimeBytes = yield* filesystem.readFile(
    new URL('../../../../apps/shell-super-app/.output/public/.well-known/ontos-shell-runtime.json', import.meta.url)
      .pathname,
  );
  const shellFederationBytes = yield* filesystem.readFile(
    new URL('../../../../apps/shell-super-app/.output/mf-manifest.json', import.meta.url).pathname,
  );
  const shellRuntime = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))(
    new TextDecoder().decode(shellRuntimeBytes),
  );
  const federation = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        shared: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            requiredVersion: Schema.optionalKey(Schema.String),
            singleton: Schema.optionalKey(Schema.Boolean),
          }),
        ),
      }),
    ),
  )(new TextDecoder().decode(shellFederationBytes));
  const singletons = yield* Effect.forEach(
    federation.shared.filter((entry) => entry.singleton === true),
    (entry) =>
      Schema.decodeUnknownEffect(ApplicationCompositionSingletonSchema)({
        packageName: entry.name,
        version: entry.requiredVersion,
      }),
  );
  const crypto = yield* Crypto.Crypto;
  const contractDigest = Hex.encode(yield* crypto.digest('SHA-256', contractBytes));
  const runtimeDigest = Hex.encode(yield* crypto.digest('SHA-256', shellRuntimeBytes));
  const federationDigest = Hex.encode(yield* crypto.digest('SHA-256', shellFederationBytes));
  const candidate: ApplicationComposition = {
    ...infrastructure.composition,
    modules: [
      {
        ...unitPlacement,
        contract: { sha256: contractDigest, url: unitPlacement.contract.url },
        contractDocument: new TextDecoder().decode(contractBytes),
        dependencies: (contract.manifest.requirements?.intrinsic ?? []).map((dependency) => dependency.moduleId),
        deployment: contract.deployment,
        moduleId: contract.manifest.module.id,
        publicContract: { id: contract.manifest.module.id, sha256: contractDigest, version: contract.schemaVersion },
        requiredCoreCapabilities: contract.manifest.requirements?.coreCapabilities ?? [],
      },
    ],
    shell: {
      ...infrastructure.composition.shell,
      contributionAbi: shellRuntime.contributionAbi,
      coreCapabilities: shellRuntime.coreCapabilities,
      deployment: shellRuntime.deployment,
      federationManifest: { sha256: federationDigest, url: infrastructure.composition.shell.federationManifest.url },
      runtimeContract: { sha256: runtimeDigest, url: infrastructure.composition.shell.runtimeContract.url },
      sharedSingletons: singletons,
    },
  };
  const observedAt = yield* DateTime.now;
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    composition: { ...candidate, revision: yield* applicationCompositionContentRevision(candidate) },
    observedAt,
    validUntil: DateTime.addDuration(observedAt, Duration.hours(1)),
  });
  return { deployment: contract.deployment, snapshot };
});
