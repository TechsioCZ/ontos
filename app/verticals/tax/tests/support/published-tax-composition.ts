import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { Effect } from 'effect';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { taxRegistration } from '../../vertical.registration.ts';

/**
 * Original Tax operation contracts at the receiving deployment's actual identity. Core's public
 * fixture validates the content-addressed TEST composition and supplies its native-runtime Shell
 * contract; no generated deployment artifact or deployed Shell is claimed by this fixture.
 */
export const publishedTaxComposition = Effect.gen(function* publishedTaxComposition() {
  const { expectedDeployment, snapshot } = yield* makeOwnerApplicationCompositionFixture({
    appId: ultramodernDeliveryUnit.appId,
    buildMarker: ultramodernDeliveryUnit.buildMarker,
    ownerRegistration: taxRegistration,
  });
  return { deployment: expectedDeployment, snapshot };
});
