import {
  Effect,
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
  makeEffectHttpApiClient,
} from '@modern-js/bff-effect/effect-client';
import { useEffect, useState } from 'react';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';

/** The shell resolves the selected legal entity from the authenticated session, never an invoice locale or URL. */
export const InvoiceIssuerSessionSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal('authenticated'),
    identity: Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.Trim.check(Schema.isMinLength(1)) }),
  }),
  Schema.Struct({ state: Schema.Literals(['anonymous', 'selection_required', 'access_blocked']) }),
]);
export const invoiceIssuerName = (session: typeof InvoiceIssuerSessionSchema.Type): string | undefined =>
  session.state === 'authenticated' ? session.identity.legalName : undefined;
const IssuerApi = HttpApi.make('FinanceInvoiceIssuerApi').add(
  HttpApiGroup.make('authentication').add(
    HttpApiEndpoint.get('currentSession', '/auth/session', { success: InvoiceIssuerSessionSchema }),
  ),
);
const lookup = makeEffectHttpApiClient(IssuerApi, { baseUrl: '/shell-super-app-api' }).pipe(
  Effect.flatMap((client) => client.authentication.currentSession({})),
  // The shell session read can take seconds while the demo machine is under load; a single 5 s attempt pinned
  // "Údaj neposkytnut" for the whole document and dropped the issuer from POHODA exports created from it.
  Effect.timeout('10 seconds'),
  Effect.retry({ times: 2 }),
  Effect.map(invoiceIssuerName),
  Effect.orElseSucceed(() => undefined),
);
// Company switching reloads the document. Share the trusted session read within this document only.
export const issuerForDocument = financeBrowserRuntime.runSync(Effect.cached(lookup));
export const useInvoiceIssuer = () => {
  const [name, setName] = useState<string>();
  useEffect(() => {
    let active = true;
    void financeBrowserRuntime.runPromise(
      issuerForDocument.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (active) setName(value);
          }),
        ),
      ),
    );
    return () => {
      active = false;
    };
  }, []);
  return name;
};
