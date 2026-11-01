import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Deferred, Effect, Schema } from 'effect';

import { AresLookupResponseSchema } from '../../shared/apis/ares-lookup.ts';
import { executeAresLookup } from '../../src/api/ares-lookup-client.ts';
import { CustomerCreateDialog } from '../../src/routes/[lang]/prodej/zakaznici/customer-create-dialog.tsx';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ t: (key: string) => key }),
}));
rstest.mock('../../src/api/ares-lookup-client.ts');

const KEY = 'party-registry.pages.customers.create';
const validIco = '27082440';

const evidence = Schema.decodeUnknownSync(AresLookupResponseSchema)({
  cacheAgeSeconds: 0,
  observedAt: '2026-09-03T08:00:00.000Z',
  provider: 'ares',
  providerChangedOn: '2026-09-01',
  providerRecordRef: `ares:ico:${validIco}`,
  queryIco: validIco,
  servedAt: '2026-09-03T08:00:00.000Z',
  status: 'FOUND',
  subject: {
    businessName: 'Příklad s.r.o.',
    dic: `CZ${validIco}`,
    dissolvedOn: null,
    establishedOn: '2020-01-02',
    ico: validIco,
    legalFormCode: '112',
    registeredAddress: {
      buildingNumber: '10',
      countryCode: 'CZ',
      formatted: 'Karlovo náměstí 10, 120 00 Praha',
      municipality: 'Praha',
      municipalityPart: null,
      orientationNumber: null,
      postalCode: '12000',
      street: 'Karlovo náměstí',
    },
  },
});

const ignore = () => {};
const renderDialog = () =>
  render(<CustomerCreateDialog existing={[]} onCreated={ignore} onOpenChange={ignore} onWriteRefused={ignore} open />);
const field = (id: string) => {
  const element = document.querySelector<HTMLInputElement>(`#${id}`);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element;
};
const type = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });

beforeEach(() => {
  rstest.mocked(executeAresLookup).mockReturnValue(Effect.succeed(evidence));
});
afterEach(cleanup);

it.live('the create form has no ARES button and looks a valid IČO up by itself, once', () =>
  Effect.gen(function* automaticLookup() {
    renderDialog();
    expect(screen.queryByRole('button', { name: `${KEY}.aresLoad` })).toBeNull();
    type('customer-ico', '2708244');
    yield* Effect.sleep('800 millis');
    expect(executeAresLookup).not.toHaveBeenCalled();
    type('customer-ico', validIco);
    yield* Effect.promise(() => waitFor(() => expect(field('customer-name').value).toBe('Příklad s.r.o.')));
    expect(executeAresLookup).toHaveBeenCalledTimes(1);
    expect(rstest.mocked(executeAresLookup).mock.calls[0]?.[0]).toEqual({ ico: validIco });
    expect(field('customer-vat-id').value).toBe(`CZ${validIco}`);
    expect(field('customer-city').value).toBe('Praha');
    expect(field('customer-postal-code').value).toBe('120 00');
    expect(screen.getByText(`${KEY}.aresDone`)).toBeTruthy();
    // Editing another field never repeats the lookup of the same IČO.
    type('customer-email', 'obchod@priklad.cz');
    yield* Effect.sleep('800 millis');
    expect(executeAresLookup).toHaveBeenCalledTimes(1);
  }),
);

it.live('a wrong checksum is reported at once and never reaches ARES', () =>
  Effect.gen(function* checksum() {
    renderDialog();
    type('customer-ico', '27082441');
    expect(screen.getByText(`${KEY}.validation.icoChecksum`)).toBeTruthy();
    yield* Effect.sleep('800 millis');
    expect(executeAresLookup).not.toHaveBeenCalled();
  }),
);

it.live('the lookup shows its progress inline and keeps every field the user typed', () =>
  Effect.gen(function* keepsTypedFields() {
    const answer = yield* Deferred.make<typeof evidence>();
    rstest.mocked(executeAresLookup).mockReturnValue(Deferred.await(answer));
    renderDialog();
    type('customer-name', 'Moje firma');
    type('customer-ico', validIco);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByText(`${KEY}.aresLoading`)).toBeTruthy()));
    type('customer-street', 'Vlastní 1');
    yield* Deferred.succeed(answer, evidence);
    yield* Effect.promise(() => waitFor(() => expect(field('customer-city').value).toBe('Praha')));
    expect(field('customer-name').value).toBe('Moje firma');
    expect(field('customer-street').value).toBe('Vlastní 1');
    expect(field('customer-vat-id').value).toBe(`CZ${validIco}`);
    expect(screen.queryByText(`${KEY}.aresLoading`)).toBeNull();
  }),
);

it.live('a quickly corrected IČO sends only the final one', () =>
  Effect.gen(function* debounce() {
    renderDialog();
    type('customer-ico', '25596641');
    yield* Effect.sleep('200 millis');
    type('customer-ico', validIco);
    yield* Effect.promise(() => waitFor(() => expect(executeAresLookup).toHaveBeenCalledTimes(1)));
    expect(rstest.mocked(executeAresLookup).mock.calls[0]?.[0]).toEqual({ ico: validIco });
  }),
);
