import { Crypto, Effect } from 'effect';

import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { CoreTransaction } from '../../db/types.ts';
import { ActiveApplicationCompositionService } from '../../modules/active-application-composition.ts';
import type { OntosDeploymentIdentitySchema } from '../../modules/manifest.ts';
import type { VerticalRuntimeRegistration } from '../../modules/runtime-registration.ts';
import { AccessEnforcementPortsLive } from '../../operations/access-gate.ts';
import { makeAccessChangesDrizzleStore } from '../changes/persistence/drizzle-store.ts';
import { callerTransactions, requestTransactions } from '../intent/persistence.ts';
import { makeJoinedTenantIntentLoader, makeTenantIntentLoader } from '../intent/tenant-intent-loader.ts';
import { makeDrizzleApprovalStore, makeJoinedDrizzleApprovalStore } from './drizzle-store.ts';
import { makeDrizzleFrozenCommandStore } from './frozen-command-drizzle-store.ts';
import type { LiveApprovalServices } from './live-composition.ts';

/** Original owner definition and receiving-release data, never dependencies or transport input. */
export interface OwnerActionApprovalConfiguration {
  readonly expectedDeployment: typeof OntosDeploymentIdentitySchema.Type;
  readonly ownerRegistration: VerticalRuntimeRegistration;
}

/**
 * Construct the same native request/joined stores once from real contextual services. Both the
 * owner lifecycle and dispatcher consume these exact objects; no database or authority is provided.
 */
export const makeOwnerActionApprovalNativeServices = Effect.fn('OwnerActionApprovals.nativeServices')(
  function* makeOwnerActionApprovalNativeServices(configuration: OwnerActionApprovalConfiguration) {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const crypto = yield* Crypto.Crypto;
    const applicationComposition = yield* ActiveApplicationCompositionService;
    const enforcement = yield* AccessEnforcementPortsLive;
    const native = { enrollment, executor: database.executor };
    const frozenCommands = makeDrizzleFrozenCommandStore(native);
    const changes = makeAccessChangesDrizzleStore(native);
    const records = makeDrizzleApprovalStore({ ...native, frozenCommands }, crypto);
    const joined = (transaction: CoreTransaction): LiveApprovalServices => ({
      crypto,
      intent: makeJoinedTenantIntentLoader(transaction, enrollment),
      join: joined,
      loadRelease: () => changes.loadPublishedCatalog(transaction),
      records: makeJoinedDrizzleApprovalStore({ enrollment, frozenCommands, transaction }, crypto),
      transactions: callerTransactions(transaction, enrollment),
    });
    const live: LiveApprovalServices = {
      crypto,
      intent: makeTenantIntentLoader(native),
      join: joined,
      loadRelease: () => changes.loadPublishedCatalog(),
      records,
      transactions: requestTransactions(native),
    };
    const owner = Object.freeze({
      applicationComposition,
      expectedDeployment: configuration.expectedDeployment,
      ownerRegistration: configuration.ownerRegistration,
    });
    return Object.freeze({ database: native, enforcement, frozenCommands, live, owners: [owner] });
  },
);
