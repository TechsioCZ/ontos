import {
  ActiveApplicationCompositionService,
  canonicalizeApplicationComposition,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import {
  makeApplicationCompositionSnapshotFixture,
  makeOwnerApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ConfigProvider, Effect, Layer } from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const digest = (document: string): string => Hex.encode(sha256Bytes(utf8ToBytes(document)));

/** The real owner's identity, embedded document, and content-addressed release are validated together. */
export const makeEnrollmentApplicationCompositionSnapshot = Effect.fn('EnrollmentTests.makeApplicationComposition')(
  function* makeEnrollmentApplicationComposition(buildMarker: string, additionalAppIds: readonly string[]) {
    const { snapshot } = yield* makeOwnerApplicationCompositionFixture({
      appId: ultramodernApiMarker.appId,
      buildMarker,
      ownerRegistration: commerceCustomerContextRegistration,
    });
    const additional = yield* makeApplicationCompositionSnapshotFixture(additionalAppIds, buildMarker);
    const composition = {
      ...snapshot.composition,
      modules: [...snapshot.composition.modules, ...additional.composition.modules],
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

const compositionSourceUrl = 'https://composition.enrollment-acceptance.test/active';

/**
 * The verification material the deployed gateway verifier and the production composition admission
 * read: the fixture's own snapshot served from the controlled composition source, with the caller's
 * gateway keys layered on top. This fixture builds the snapshot in process, so — unlike the
 * deployment's own support — it reads no published Shell artifact.
 */
export const enrollmentApplicationCompositionVerificationLayer = (
  snapshot: ActiveApplicationCompositionSnapshot,
  gatewayConfiguration: Readonly<Record<string, string>> = {},
) =>
  Layer.mergeAll(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ...gatewayConfiguration,
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: compositionSourceUrl,
      }),
    ),
    Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
      const request = new Request(input, init);
      return request.url === compositionSourceUrl ? Response.json(snapshot) : await fetch(request);
    }),
  );
