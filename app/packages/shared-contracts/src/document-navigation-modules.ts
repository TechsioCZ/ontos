import { Predicate } from 'effect';

// The shell pins, per document, the module ids its composition read lists in the signed-in person's navigation for
// the current company. Remotes use it to skip optional cross-module reads (reference names, related records,
// statistics sources) for modules the person cannot open, without asking the shell for its composition again. A hint
// only: every module still authorizes each request. Company switches and sign-out reload the document, which drops it.
const documentNavigationModulesKey = Symbol.for('ontos.document-navigation-modules');

const currentDocument = (): Document | undefined => ('document' in globalThis ? globalThis.document : undefined);

/** Replaces the hint each time the shell reads its composition (the read can be revalidated within one document). */
export const pinDocumentNavigationModules = (moduleIds: readonly string[], browserDocument: Document): void => {
  Object.defineProperty(browserDocument, documentNavigationModulesKey, {
    configurable: true,
    enumerable: false,
    value: Object.freeze([...moduleIds]),
    writable: false,
  });
};

/**
 * The module ids of the pinned shell navigation; `undefined` without a hint (server, tests, other hosts, or a shell
 * whose composition was unavailable), which callers treat as "unknown" and read as before.
 */
export const documentNavigationModules = (): ReadonlySet<string> | undefined => {
  const browserDocument = currentDocument();
  if (browserDocument === undefined) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(browserDocument, documentNavigationModulesKey)?.value;
  return Array.isArray(value) && value.every(Predicate.isString) ? new Set(value) : undefined;
};
