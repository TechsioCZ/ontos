export { CommercePortalAuthStepUpChallengeIdSchema } from './contracts.ts';
export type { CommercePortalAuthStepUpChallengeRecord } from './contracts.ts';
export { CommercePortalAuthStepUpCodeRejected } from './code-rejected.ts';
export {
  CommercePortalAuthStepUpChallengeStoreService,
  type CommercePortalAuthStepUpChallengeStore,
} from './challenge-store-service.ts';
export {
  CommercePortalAuthStepUpCodeVerifierService,
  type CommercePortalAuthStepUpCodeVerifier,
} from './code-verifier-service.ts';
export { CommercePortalAuthStepUpRejected } from './rejected.ts';
export { CommercePortalAuthStepUpUnavailable } from './unavailable.ts';
export { CommercePortalAuthStepUpService } from './step-up-service.ts';
export type { CommercePortalAuthStepUp } from './step-up-service.ts';
export { makeCommercePortalAuthStepUp } from './step-up.ts';
/**
 * Wave-2 U6 moved the drizzle-touching implementation out of `/api/` (design §6 persistence
 * table); the barrel keeps re-exporting it under its established name for callers that have not
 * migrated to importing `src/portal-auth/persistence/portal-auth-step-up-store.ts` directly yet.
 */
export { makeCommercePortalAuthStepUpChallengeStore } from '../../../../src/portal-auth/persistence/portal-auth-step-up-store.ts';
export { CommercePortalAuthStepUpHttpProviderService, portalAuthStepUpStandaloneApiLive } from './http.ts';
export type { CommercePortalAuthStepUpHttpProvider } from './http.ts';
export {
  CommercePortalAuthStepUpApi,
  CommercePortalAuthStepUpForbiddenProblemSchema,
  CommercePortalAuthStepUpRejectedProblemSchema,
  CommercePortalAuthStepUpUnavailableProblemSchema,
} from '../../../../shared/portal-auth/step-up-api.ts';
