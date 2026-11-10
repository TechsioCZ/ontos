import { Effect, Layer } from 'effect';

import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../../modules/application-composition-catalog.ts';
import { declaredActionAuthorities } from '../../permissions/action-authority.ts';
import { AccessIntent } from '../decision/authority.ts';
import { DecisionCheck } from '../decision/engine.ts';
import { AccessPrincipalKindSource } from './actor.ts';
import { AccessDecisionLogBatch } from './decision-log-batch.ts';
import { SubjectAccessInspection, SubjectInspectionUnavailable } from './inspection-contract.ts';
import { SubjectInspectionIdentitySource } from './inspection-facts.ts';
import { makeSubjectAccessInspection } from './inspection.ts';

/** Capture once at a composition root, then retain this real service in the request Context. */
export const SubjectAccessInspectionLive: Layer.Layer<
  SubjectAccessInspection,
  never,
  | AccessIntent
  | DecisionCheck
  | AccessPrincipalKindSource
  | AccessDecisionLogBatch
  | SubjectInspectionIdentitySource
  | ActiveApplicationCompositionService
> = Layer.effect(
  SubjectAccessInspection,
  Effect.gen(function* subjectInspectionLive() {
    const [intent, check, principalKinds, decisionLog, identities, composition] = yield* Effect.all(
      [
        AccessIntent,
        DecisionCheck,
        AccessPrincipalKindSource,
        AccessDecisionLogBatch,
        SubjectInspectionIdentitySource,
        ActiveApplicationCompositionService,
      ] as const,
      { concurrency: 1 },
    );
    const currentCatalog = Effect.gen(function* currentInspectionCatalog() {
      const snapshot = yield* composition.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
      const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);
      return { actions: declaredActionAuthorities(catalog), revision: snapshot.composition.revision };
    }).pipe(
      Effect.mapError(
        (cause) => new SubjectInspectionUnavailable({ cause, reason: 'Current inspection catalog is unavailable' }),
      ),
    );
    return makeSubjectAccessInspection({
      authorityFor: intent.authorityFor,
      check,
      currentCatalog,
      decisionLog,
      identities,
      principalKinds,
    });
  }),
);
