import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  getDocumentCompositionRevision,
  pinDocumentCompositionRevision,
} from '../../src/document-composition-revision.ts';

// The unit project runs in Node, which has no browser document: the server and Worker case.
it.effect('fails closed without a browser document', () =>
  Effect.gen(function* missingDocumentEffect() {
    expect('document' in globalThis).toBe(false);
    const missing = yield* getDocumentCompositionRevision().pipe(Effect.flip);
    expect(missing.reason).toBe('document-unavailable');
    const missingPin = yield* pinDocumentCompositionRevision('a'.repeat(64)).pipe(Effect.flip);
    expect(missingPin.reason).toBe('document-unavailable');
  }),
);
