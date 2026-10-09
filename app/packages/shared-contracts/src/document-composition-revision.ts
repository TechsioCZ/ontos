import { Effect, Schema } from 'effect';

const documentCompositionRevisionKey = Symbol.for('ontos.document-composition-revision');
const revisionSchema = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const documentUnavailable = 'document-unavailable';
const invalidRevision = 'invalid-revision';

export class DocumentCompositionRevisionError extends Schema.TaggedError<DocumentCompositionRevisionError>()(
  'DocumentCompositionRevisionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.Literals([
      documentUnavailable,
      'uninitialized',
      invalidRevision,
      'revision-mismatch',
      'pin-unavailable',
    ]),
  },
) {}

const currentDocument = (): Document | undefined => ('document' in globalThis ? globalThis.document : undefined);

const sealDocumentCompositionRevision = (revision: string, browserDocument: Document) =>
  Effect.try({
    catch: (cause) => new DocumentCompositionRevisionError({ cause, reason: 'pin-unavailable' }),
    try: () => {
      Object.defineProperty(browserDocument, documentCompositionRevisionKey, {
        configurable: false,
        enumerable: false,
        value: revision,
        writable: false,
      });
    },
  });

const readDocumentCompositionRevision = Effect.fn('DocumentComposition.readRevision')(
  function* readDocumentCompositionRevisionEffect(browserDocument: Document) {
    const descriptor = Object.getOwnPropertyDescriptor(browserDocument, documentCompositionRevisionKey);
    if (descriptor !== undefined) {
      const revision: unknown = descriptor.value;
      if (descriptor.configurable !== false || descriptor.writable !== false || !Schema.is(revisionSchema)(revision)) {
        return yield* new DocumentCompositionRevisionError({ reason: invalidRevision });
      }
      return revision;
    }

    const metadata = yield* Effect.try({
      catch: (cause) => new DocumentCompositionRevisionError({ cause, reason: invalidRevision }),
      try: () => browserDocument.querySelectorAll<HTMLMetaElement>('meta[name="ontos-composition-revision"]'),
    });
    if (metadata.length === 0) {
      return null;
    }
    if (metadata.length !== 1) {
      return yield* new DocumentCompositionRevisionError({ reason: invalidRevision });
    }
    const revision = metadata.item(0).getAttribute('content');
    if (!Schema.is(revisionSchema)(revision)) {
      return yield* new DocumentCompositionRevisionError({ reason: invalidRevision });
    }
    yield* sealDocumentCompositionRevision(revision, browserDocument);
    return revision;
  },
);

/** The pin belongs to the document, so separately bundled remote clients read the same revision. */
export const getDocumentCompositionRevision = Effect.fn('DocumentComposition.getRevision')(
  function* getDocumentCompositionRevisionEffect(browserDocument: Document | undefined = currentDocument()) {
    if (browserDocument === undefined) {
      return yield* new DocumentCompositionRevisionError({ reason: documentUnavailable });
    }
    const revision = yield* readDocumentCompositionRevision(browserDocument);
    if (revision === null) {
      return yield* new DocumentCompositionRevisionError({ reason: 'uninitialized' });
    }
    return revision;
  },
);

/** A new document admits one release. Refreshing its lease never replaces that release. */
export const pinDocumentCompositionRevision = Effect.fn('DocumentComposition.pinRevision')(
  function* pinDocumentCompositionRevisionEffect(
    revision: string,
    browserDocument: Document | undefined = currentDocument(),
  ) {
    if (browserDocument === undefined) {
      return yield* new DocumentCompositionRevisionError({ reason: documentUnavailable });
    }
    if (!Schema.is(revisionSchema)(revision)) {
      return yield* new DocumentCompositionRevisionError({ reason: invalidRevision });
    }
    const previous = yield* readDocumentCompositionRevision(browserDocument);
    if (previous !== null) {
      if (previous !== revision) {
        return yield* new DocumentCompositionRevisionError({ reason: 'revision-mismatch' });
      }
      return yield* Effect.void;
    }
    return yield* sealDocumentCompositionRevision(revision, browserDocument);
  },
);
