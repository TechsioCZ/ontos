import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';

import { formatGeneratedMutationContent } from '../shared.mts';

it.effect('formats identifier API keys while preserving required quoted slugs', () =>
  formatGeneratedMutationContent(
    '/workspace/verticals/catalog/vertical.manifest.ts',
    `export const manifest = {\n  publicSurface: {\n    api: {\n      configuration: ConfigurationApi,\n      'decision-explanation': DecisionExplanationApi,\n    },\n  },\n};\n`,
  ).pipe(
    Effect.tap((formatted) =>
      Effect.sync(() => {
        expect(formatted).toContain('configuration: ConfigurationApi,');
        expect(formatted).toContain("'decision-explanation': DecisionExplanationApi,");
      }),
    ),
  ),
);
