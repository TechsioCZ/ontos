// The shell pins, per document, the deployments whose module access its composition read found definitely denied
// for the signed-in person in the current company. The browser gateway then answers a request for such an audience
// with GatewayForbiddenProblem without issuing an assertion or calling the module, so optional cross-module reads
// (a calendar source, tag chips) stay quiet in the console. A hint only: every module still authorizes each request,
// and a missing hint changes nothing. Company switches and sign-out reload the document, which drops the hint.
const documentDeniedAppsKey = Symbol.for('ontos.document-denied-apps');

const currentDocument = (): Document | undefined => ('document' in globalThis ? globalThis.document : undefined);

/** Replaces the hint each time the shell reads its composition (the read can be revalidated within one document). */
export const pinDocumentDeniedApps = (appIds: readonly string[], browserDocument: Document): void => {
  Object.defineProperty(browserDocument, documentDeniedAppsKey, {
    configurable: true,
    enumerable: false,
    value: Object.freeze([...appIds]),
    writable: false,
  });
};

/** True only when the pinned shell hint lists `appId`; without a hint (server, tests, other hosts) always false. */
export const isDocumentAppDenied = (appId: string): boolean => {
  const browserDocument = currentDocument();
  if (browserDocument === undefined) {
    return false;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(browserDocument, documentDeniedAppsKey)?.value;
  return Array.isArray(value) && value.includes(appId);
};
