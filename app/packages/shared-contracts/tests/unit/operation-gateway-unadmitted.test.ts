// @rstest-environment happy-dom
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { DocumentCompositionRevisionError } from '../../src/document-composition-revision.ts';
import { makeOperationGateway } from '../../src/operation-gateway.ts';

// The gateway reads the ambient browser document, so this file's document never admits a release.
const approvedTarget = {
  apiBaseUrl: '/shell-super-app-api/module-api/inventory-stock/build-1/inventory-stock-api',
  compositionRevision: 'a'.repeat(64),
};
const audience = 'inventory-stock' as const;

it.effect('does not contact the issuer or owner before the document admits a release', () =>
  Effect.gen(function* missingDocumentRevisionEffect() {
    let issuerCalls = 0;
    let attemptCalls = 0;
    const gateway = makeOperationGateway(audience, () => {
      issuerCalls += 1;
      return Effect.succeed({ ...approvedTarget, expiresAt: 1_700_000_300, token: 'must not issue' });
    });

    const failure = yield* gateway
      .invoke(() => {
        attemptCalls += 1;
        return Effect.void;
      })
      .pipe(Effect.flip);

    expect(Schema.is(DocumentCompositionRevisionError)(failure)).toBe(true);
    const documentFailure = yield* Schema.decodeUnknownEffect(DocumentCompositionRevisionError)(failure);
    expect(documentFailure.reason).toBe('uninitialized');
    expect(issuerCalls).toBe(0);
    expect(attemptCalls).toBe(0);
  }),
);
