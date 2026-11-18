// @rstest-environment happy-dom
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { pinDocumentCompositionRevision } from '@app/shared-contracts';

import { makeOperationGateway } from '../../src/api/action-gateway.ts';

const compositionRevision = 'a'.repeat(64);

it.effect('constructs fresh audience credentials for each invocation attempt', () =>
  Effect.gen(function* freshGatewayCredentials() {
    yield* pinDocumentCompositionRevision(compositionRevision);
    const observations: string[] = [];
    let issued = 0;
    const gateway = makeOperationGateway(({ audience }) =>
      Effect.sync(() => {
        issued += 1;
        observations.push(audience);
        return {
          apiBaseUrl: '/module-api/price-group-catalog',
          compositionRevision,
          expiresAt: 1_791_166_700,
          token: `token-${issued}`,
        };
      }),
    );
    const first = yield* gateway.invoke((authorization) => Effect.succeed(authorization));
    const second = yield* gateway.invoke((authorization) => Effect.succeed(authorization));

    expect(first).toBe('Bearer token-1');
    expect(second).toBe('Bearer token-2');
    expect(observations).toEqual(['price-group-catalog', 'price-group-catalog']);
  }),
);
