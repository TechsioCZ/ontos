import { Effect, Layer } from 'effect';
import { it } from 'effect-rstest';
import {
  catalogScopeScenario,
  openAndFiniteScenario,
  temporalArtifactsLayer,
  temporalCaseLayer,
} from './price-group-effective-period-postgres.fixture.ts';

const temporalArtifactMemoMap = Layer.makeMemoMapUnsafe();

it.layer(temporalArtifactsLayer, { excludeTestServices: true, memoMap: temporalArtifactMemoMap, timeout: 120_000 })(
  () => {
    it.layer(temporalCaseLayer('current').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'separates genuine missing incompatible retired unavailable Catalog, wrong scope, and child rollback outcomes',
        () => Effect.scoped(catalogScopeScenario()),
        120_000,
      );
    });

    it.layer(temporalCaseLayer('current').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'preserves open and finite Retail and Counterparty schedules through same-start replacement, exclusive expiry and same-revision observation renewal',
        () => Effect.scoped(openAndFiniteScenario()),
        120_000,
      );
    });
  },
);
