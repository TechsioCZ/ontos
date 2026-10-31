import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionUnavailableError,
  canonicalizeApplicationComposition,
  OntosModuleDeploymentContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';
import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Layer, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const digest = (document: string): string => Hex.encode(sha256Bytes(utf8ToBytes(document)));
const contractJson = Schema.fromJsonString(OntosModuleDeploymentContractSchema);

/** The real owner's identity, embedded document, and content-addressed release are validated together. */
export const makeEnrollmentApplicationCompositionSnapshot = Effect.fn('EnrollmentTests.makeApplicationComposition')(
  function* makeEnrollmentApplicationComposition(buildMarker: string, additionalAppIds: readonly string[]) {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernApiMarker.appId, ...additionalAppIds],
      buildMarker,
    );
    const contract = yield* Schema.decodeEffect(OntosModuleDeploymentContractSchema)(
      makeModuleContractFixture({
        appId: ultramodernApiMarker.appId,
        buildMarker,
        moduleId: 'commerce.customer-context',
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ActiveApplicationCompositionUnavailableError({
            cause,
            reason: 'The enrollment test deployment contract is invalid',
          }),
      ),
    );
    const contractDocument = yield* Schema.encodeEffect(contractJson)(contract).pipe(
      Effect.mapError(
        (cause) =>
          new ActiveApplicationCompositionUnavailableError({
            cause,
            reason: 'The enrollment test deployment contract could not be encoded',
          }),
      ),
    );
    const sha256 = digest(contractDocument);
    const composition = {
      ...snapshot.composition,
      modules: snapshot.composition.modules.map((module) =>
        module.deployment.appId === ultramodernApiMarker.appId
          ? {
              ...module,
              contract: { ...module.contract, sha256 },
              contractDocument,
              moduleId: contract.manifest.module.id,
              publicContract: { id: contract.manifest.module.id, sha256, version: contract.schemaVersion },
            }
          : module,
      ),
      revision: '0'.repeat(64),
    };
    return yield* validateActiveApplicationCompositionSnapshot({
      ...snapshot,
      composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
    });
  },
);

export const enrollmentApplicationCompositionSnapshot = makeEnrollmentApplicationCompositionSnapshot(
  ultramodernApiMarker.buildMarker,
  [],
);
export const enrollmentApplicationCompositionRevision = enrollmentApplicationCompositionSnapshot.pipe(
  Effect.map((snapshot) => snapshot.composition.revision),
);
export const enrollmentApplicationCompositionLayer = Layer.succeed(ActiveApplicationCompositionService, {
  load: enrollmentApplicationCompositionSnapshot,
});
