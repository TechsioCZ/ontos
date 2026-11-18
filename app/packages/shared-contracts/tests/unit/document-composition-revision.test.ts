// @rstest-environment happy-dom
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  getDocumentCompositionRevision,
  pinDocumentCompositionRevision,
} from '../../src/document-composition-revision.ts';

const revision = 'a'.repeat(64);
const revisionKey = Symbol.for('ontos.document-composition-revision');

/** A fresh browser document whose server-rendered head carries these composition metadata contents. */
const makeDocument = (metadata: readonly (string | null)[] = []): Document => {
  const browserDocument = document.implementation.createHTMLDocument('composition');
  for (const content of metadata) {
    const meta = browserDocument.createElement('meta');
    meta.setAttribute('name', 'ontos-composition-revision');
    if (content !== null) {
      meta.setAttribute('content', content);
    }
    browserDocument.head.append(meta);
  }
  return browserDocument;
};

it.effect('fails closed for a browser document that has admitted no release', () =>
  Effect.gen(function* uninitializedDocumentEffect() {
    const uninitialized = yield* getDocumentCompositionRevision(makeDocument()).pipe(Effect.flip);
    expect(uninitialized.reason).toBe('uninitialized');
  }),
);

it.effect('pins and reads the ambient browser document when no document is passed', () =>
  Effect.gen(function* ambientDocumentEffect() {
    yield* pinDocumentCompositionRevision(revision);
    expect(yield* getDocumentCompositionRevision()).toBe(revision);
    expect(yield* getDocumentCompositionRevision(document)).toBe(revision);
  }),
);

it.effect('rejects invalid identities before pinning and preserves one exact revision', () =>
  Effect.gen(function* immutableDocumentEffect() {
    const browserDocument = makeDocument();
    for (const invalid of ['', 'a'.repeat(63), 'A'.repeat(64), `sha256:${revision}`]) {
      const failure = yield* pinDocumentCompositionRevision(invalid, browserDocument).pipe(Effect.flip);
      expect(failure.reason).toBe('invalid-revision');
    }
    yield* pinDocumentCompositionRevision(revision, browserDocument);
    yield* pinDocumentCompositionRevision(revision, browserDocument);
    expect(yield* getDocumentCompositionRevision(browserDocument)).toBe(revision);
    const failure = yield* pinDocumentCompositionRevision('b'.repeat(64), browserDocument).pipe(Effect.flip);
    expect(failure.reason).toBe('revision-mismatch');
    expect(Reflect.set(browserDocument, revisionKey, 'b'.repeat(64))).toBe(false);
    expect(Reflect.deleteProperty(browserDocument, revisionKey)).toBe(false);
    expect(yield* getDocumentCompositionRevision(browserDocument)).toBe(revision);
  }),
);

it.effect('keeps revisions isolated between documents and shares the pin by native symbol identity', () =>
  Effect.gen(function* independentDocumentsEffect() {
    const firstDocument = makeDocument();
    const secondDocument = makeDocument();
    yield* pinDocumentCompositionRevision(revision, firstDocument);
    yield* pinDocumentCompositionRevision('b'.repeat(64), secondDocument);
    expect(yield* getDocumentCompositionRevision(firstDocument)).toBe(revision);
    expect(yield* getDocumentCompositionRevision(secondDocument)).toBe('b'.repeat(64));
    expect(Object.getOwnPropertyDescriptor(firstDocument, revisionKey)).toEqual({
      configurable: false,
      enumerable: false,
      value: revision,
      writable: false,
    });
  }),
);

it.effect('seals the revision captured by SSR before the first browser read', () =>
  Effect.gen(function* serverRenderedDocumentEffect() {
    const browserDocument = makeDocument([revision]);
    expect(yield* getDocumentCompositionRevision(browserDocument)).toBe(revision);
    expect(Object.getOwnPropertyDescriptor(browserDocument, revisionKey)).toEqual({
      configurable: false,
      enumerable: false,
      value: revision,
      writable: false,
    });
  }),
);

it.effect('rejects a first browser pin that disagrees with the SSR revision', () =>
  Effect.gen(function* serverRenderedRevisionMismatchEffect() {
    const browserDocument = makeDocument([revision]);
    const failure = yield* pinDocumentCompositionRevision('b'.repeat(64), browserDocument).pipe(Effect.flip);
    expect(failure.reason).toBe('revision-mismatch');
    expect(yield* getDocumentCompositionRevision(browserDocument)).toBe(revision);
  }),
);

it.effect('keeps the captured SSR revision through lease renewal and metadata changes', () =>
  Effect.gen(function* serverRenderedLeaseRenewalEffect() {
    const browserDocument = makeDocument([revision]);
    yield* pinDocumentCompositionRevision(revision, browserDocument);
    yield* pinDocumentCompositionRevision(revision, browserDocument);
    browserDocument.querySelector('meta[name="ontos-composition-revision"]')?.setAttribute('content', 'b'.repeat(64));
    expect(yield* getDocumentCompositionRevision(browserDocument)).toBe(revision);
    yield* pinDocumentCompositionRevision(revision, browserDocument);
    const failure = yield* pinDocumentCompositionRevision('b'.repeat(64), browserDocument).pipe(Effect.flip);
    expect(failure.reason).toBe('revision-mismatch');
  }),
);

it.effect('fails closed for duplicated SSR metadata without admitting a browser release', () =>
  Effect.gen(function* duplicateServerRenderedMetadataEffect() {
    for (const metadata of [
      [revision, revision],
      [revision, 'b'.repeat(64)],
    ]) {
      const browserDocument = makeDocument(metadata);
      const readFailure = yield* getDocumentCompositionRevision(browserDocument).pipe(Effect.flip);
      expect(readFailure.reason).toBe('invalid-revision');
      const pinFailure = yield* pinDocumentCompositionRevision(revision, browserDocument).pipe(Effect.flip);
      expect(pinFailure.reason).toBe('invalid-revision');
      expect(Object.getOwnPropertyDescriptor(browserDocument, revisionKey)).toBeUndefined();
    }
  }),
);

it.effect('fails closed for missing or malformed SSR content without replacing it', () =>
  Effect.gen(function* malformedServerRenderedMetadataEffect() {
    for (const invalid of [null, '', 'a'.repeat(63), 'A'.repeat(64), `sha256:${revision}`, ` ${revision}`]) {
      const browserDocument = makeDocument([invalid]);
      const readFailure = yield* getDocumentCompositionRevision(browserDocument).pipe(Effect.flip);
      expect(readFailure.reason).toBe('invalid-revision');
      const pinFailure = yield* pinDocumentCompositionRevision(revision, browserDocument).pipe(Effect.flip);
      expect(pinFailure.reason).toBe('invalid-revision');
      expect(Object.getOwnPropertyDescriptor(browserDocument, revisionKey)).toBeUndefined();
    }
  }),
);

it.effect('does not trust an unsealed property or silently repair a corrupted pin', () =>
  Effect.gen(function* corruptedDocumentEffect() {
    const browserDocument = makeDocument();
    Object.defineProperty(browserDocument, revisionKey, {
      configurable: true,
      value: revision,
      writable: true,
    });
    const failure = yield* getDocumentCompositionRevision(browserDocument).pipe(Effect.flip);
    expect(failure.reason).toBe('invalid-revision');
    const pinFailure = yield* pinDocumentCompositionRevision(revision, browserDocument).pipe(Effect.flip);
    expect(pinFailure.reason).toBe('invalid-revision');
  }),
);

it.effect('reports an unavailable document pin without retaining server state', () =>
  Effect.gen(function* frozenDocumentEffect() {
    const browserDocument = makeDocument();
    Object.preventExtensions(browserDocument);
    const failure = yield* pinDocumentCompositionRevision(revision, browserDocument).pipe(Effect.flip);
    expect(failure.reason).toBe('pin-unavailable');
    const readFailure = yield* getDocumentCompositionRevision(browserDocument).pipe(Effect.flip);
    expect(readFailure.reason).toBe('uninitialized');
  }),
);
