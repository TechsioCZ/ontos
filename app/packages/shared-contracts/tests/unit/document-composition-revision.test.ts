import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import {
  getDocumentCompositionRevision,
  pinDocumentCompositionRevision,
} from '../../src/document-composition-revision.ts';

const revision = 'a'.repeat(64);
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const installDocument = (metadata: readonly (string | null)[] = []) => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('meta[name="ontos-composition-revision"]');
        return {
          item: (index: number) => ({
            getAttribute: (attribute: string) => {
              expect(attribute).toBe('content');
              return metadata[index] ?? null;
            },
          }),
          length: metadata.length,
        };
      },
    },
  });
};
beforeEach(() => {
  installDocument();
});
afterEach(() => {
  if (previousDocument === undefined) {
    Reflect.deleteProperty(globalThis, 'document');
  } else {
    Object.defineProperty(globalThis, 'document', previousDocument);
  }
});

it.effect('fails closed without a browser document or an admitted release', () =>
  Effect.gen(function* uninitializedDocumentEffect() {
    const uninitialized = yield* getDocumentCompositionRevision().pipe(Effect.flip);
    expect(uninitialized.reason).toBe('uninitialized');
    Reflect.deleteProperty(globalThis, 'document');
    const missing = yield* getDocumentCompositionRevision().pipe(Effect.flip);
    expect(missing.reason).toBe('document-unavailable');
    const missingPin = yield* pinDocumentCompositionRevision(revision).pipe(Effect.flip);
    expect(missingPin.reason).toBe('document-unavailable');
  }),
);

it.effect('rejects invalid identities before pinning and preserves one exact revision', () =>
  Effect.gen(function* immutableDocumentEffect() {
    for (const invalid of ['', 'a'.repeat(63), 'A'.repeat(64), `sha256:${revision}`]) {
      const failure = yield* pinDocumentCompositionRevision(invalid).pipe(Effect.flip);
      expect(failure.reason).toBe('invalid-revision');
    }
    yield* pinDocumentCompositionRevision(revision);
    yield* pinDocumentCompositionRevision(revision);
    expect(yield* getDocumentCompositionRevision()).toBe(revision);
    const failure = yield* pinDocumentCompositionRevision('b'.repeat(64)).pipe(Effect.flip);
    expect(failure.reason).toBe('revision-mismatch');
    const key = Symbol.for('ontos.document-composition-revision');
    expect(Reflect.set(document, key, 'b'.repeat(64))).toBe(false);
    expect(Reflect.deleteProperty(document, key)).toBe(false);
    expect(yield* getDocumentCompositionRevision()).toBe(revision);
  }),
);

it.effect('keeps revisions isolated between documents and shares the pin by native symbol identity', () =>
  Effect.gen(function* independentDocumentsEffect() {
    const firstDocument = document;
    yield* pinDocumentCompositionRevision(revision, firstDocument);
    installDocument();
    const secondDocument = document;
    yield* pinDocumentCompositionRevision('b'.repeat(64), secondDocument);
    expect(yield* getDocumentCompositionRevision(firstDocument)).toBe(revision);
    expect(yield* getDocumentCompositionRevision(secondDocument)).toBe('b'.repeat(64));
    expect(Object.getOwnPropertyDescriptor(firstDocument, Symbol.for('ontos.document-composition-revision'))).toEqual({
      configurable: false,
      enumerable: false,
      value: revision,
      writable: false,
    });
  }),
);

it.effect('seals the revision captured by SSR before the first browser read', () =>
  Effect.gen(function* serverRenderedDocumentEffect() {
    installDocument([revision]);
    expect(yield* getDocumentCompositionRevision()).toBe(revision);
    expect(Object.getOwnPropertyDescriptor(document, Symbol.for('ontos.document-composition-revision'))).toEqual({
      configurable: false,
      enumerable: false,
      value: revision,
      writable: false,
    });
  }),
);

it.effect('rejects a first browser pin that disagrees with the SSR revision', () =>
  Effect.gen(function* serverRenderedRevisionMismatchEffect() {
    installDocument([revision]);
    const failure = yield* pinDocumentCompositionRevision('b'.repeat(64)).pipe(Effect.flip);
    expect(failure.reason).toBe('revision-mismatch');
    expect(yield* getDocumentCompositionRevision()).toBe(revision);
  }),
);

it.effect('keeps the captured SSR revision through lease renewal and metadata changes', () =>
  Effect.gen(function* serverRenderedLeaseRenewalEffect() {
    const metadata = [revision];
    installDocument(metadata);
    yield* pinDocumentCompositionRevision(revision);
    yield* pinDocumentCompositionRevision(revision);
    metadata[0] = 'b'.repeat(64);
    expect(yield* getDocumentCompositionRevision()).toBe(revision);
    yield* pinDocumentCompositionRevision(revision);
    const failure = yield* pinDocumentCompositionRevision('b'.repeat(64)).pipe(Effect.flip);
    expect(failure.reason).toBe('revision-mismatch');
  }),
);

it.effect('fails closed for duplicated SSR metadata without admitting a browser release', () =>
  Effect.gen(function* duplicateServerRenderedMetadataEffect() {
    for (const metadata of [
      [revision, revision],
      [revision, 'b'.repeat(64)],
    ]) {
      installDocument(metadata);
      const readFailure = yield* getDocumentCompositionRevision().pipe(Effect.flip);
      expect(readFailure.reason).toBe('invalid-revision');
      const pinFailure = yield* pinDocumentCompositionRevision(revision).pipe(Effect.flip);
      expect(pinFailure.reason).toBe('invalid-revision');
      expect(
        Object.getOwnPropertyDescriptor(document, Symbol.for('ontos.document-composition-revision')),
      ).toBeUndefined();
    }
  }),
);

it.effect('fails closed for missing or malformed SSR content without replacing it', () =>
  Effect.gen(function* malformedServerRenderedMetadataEffect() {
    for (const invalid of [null, '', 'a'.repeat(63), 'A'.repeat(64), `sha256:${revision}`, ` ${revision}`]) {
      installDocument([invalid]);
      const readFailure = yield* getDocumentCompositionRevision().pipe(Effect.flip);
      expect(readFailure.reason).toBe('invalid-revision');
      const pinFailure = yield* pinDocumentCompositionRevision(revision).pipe(Effect.flip);
      expect(pinFailure.reason).toBe('invalid-revision');
      expect(
        Object.getOwnPropertyDescriptor(document, Symbol.for('ontos.document-composition-revision')),
      ).toBeUndefined();
    }
  }),
);

it.effect('does not trust an unsealed property or silently repair a corrupted pin', () =>
  Effect.gen(function* corruptedDocumentEffect() {
    Object.defineProperty(document, Symbol.for('ontos.document-composition-revision'), {
      configurable: true,
      value: revision,
      writable: true,
    });
    const failure = yield* getDocumentCompositionRevision().pipe(Effect.flip);
    expect(failure.reason).toBe('invalid-revision');
    const pinFailure = yield* pinDocumentCompositionRevision(revision).pipe(Effect.flip);
    expect(pinFailure.reason).toBe('invalid-revision');
  }),
);

it.effect('reports an unavailable document pin without retaining server state', () =>
  Effect.gen(function* frozenDocumentEffect() {
    Object.preventExtensions(document);
    const failure = yield* pinDocumentCompositionRevision(revision).pipe(Effect.flip);
    expect(failure.reason).toBe('pin-unavailable');
    const readFailure = yield* getDocumentCompositionRevision().pipe(Effect.flip);
    expect(readFailure.reason).toBe('uninitialized');
  }),
);
