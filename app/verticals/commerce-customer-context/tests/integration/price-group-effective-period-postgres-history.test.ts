import { Effect, Layer } from 'effect';
import { it } from 'effect-rstest';
import {
  cancellationScenario,
  temporalArtifactsLayer,
  temporalCaseLayer,
  temporalScenario,
} from './price-group-effective-period-postgres.fixture.ts';

const temporalArtifactMemoMap = Layer.makeMemoMapUnsafe();

it.layer(temporalArtifactsLayer, { excludeTestServices: true, memoMap: temporalArtifactMemoMap, timeout: 120_000 })(
  () => {
    it.layer(temporalCaseLayer('before').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'preserves actual Retail and Counterparty periods across the historical resolver body and real forward replacement without rewriting the journal or original audit',
        () => Effect.scoped(temporalScenario()),
        // Native scenario bodies measure 19–31s locally; keep headroom for the slower CI runner.
        120_000,
      );
    });

    it.layer(temporalCaseLayer('current').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'retains same-start and inverted cancellation intent with one genuine concurrent removal winner',
        () => Effect.scoped(cancellationScenario()),
        120_000,
      );
    });
  },
);
