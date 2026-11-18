// @rstest-environment happy-dom
import {
  acted,
  passFakeTime,
  settleOnFakeTimers,
  unmountAll,
  waitUntilOnFakeTimers,
} from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Deferred, Effect, Schema } from 'effect';

import { AresLookupApi, AresLookupResponseSchema } from '../../shared/apis/ares-lookup.ts';
import type { AresLookupRequest } from '../../shared/apis/ares-lookup.ts';
import { partyRegistryI18nResources } from '../../src/i18n/resources.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';
import { CustomerCreateDialog } from '../../src/routes/[lang]/prodej/zakaznici/customer-create-dialog.tsx';

const KEY = 'party-registry.pages.customers.create';
const validIco = '27082440';
const copy = moduleText('cs', partyRegistryI18nResources);

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

const requests: AresLookupRequest[] = [];
let answer: Effect.Effect<typeof evidence> = Effect.succeed(evidence);
const OwnerApi = AresLookupApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'party-registry': '/party-registry-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'aresLookup', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          requests.push(payload);
          return answer;
        }),
      ),
    ),
  ),
);

const ignore = () => {};
const renderDialog = () =>
  mountInRoute(
    <CustomerCreateDialog existing={[]} onCreated={ignore} onOpenChange={ignore} onWriteRefused={ignore} open />,
    {
      path: 'prodej/zakaznici',
      resources: partyRegistryI18nResources,
      settle: settleOnFakeTimers,
      url: '/cs/prodej/zakaznici',
    },
  );
const field = (id: string) => {
  const element = document.querySelector<HTMLInputElement>(`#${id}`);
  if (element === null) {
    throw new Error(`missing #${id}`);
  }
  return element;
};
const type = (id: string, value: string) =>
  acted(() => {
    fireEvent.change(field(id), { target: { value } });
  }, settleOnFakeTimers);

beforeEach(() => {
  // The lookup waits for typing to pause on the browser runtime's clock: `setTimeout`.
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  requests.length = 0;
  answer = Effect.succeed(evidence);
});
afterEach(() => {
  unmountAll();
  rstest.useRealTimers();
});

it.layer(network, { excludeTestServices: true })('customer create ares', (suite) => {
  suite.effect('the create form has no ARES button and looks a valid IČO up by itself, once', () =>
    Effect.gen(function* automaticLookup() {
      yield* pinTestDocument;
      yield* renderDialog();
      expect(screen.queryByRole('button', { name: /ARES/u })).toBeNull();
      yield* type('customer-ico', '2708244');
      yield* passFakeTime('800 millis', { between: networkIdle });
      expect(requests).toHaveLength(0);
      yield* type('customer-ico', validIco);
      yield* passFakeTime('800 millis');
      yield* waitUntilOnFakeTimers(() => field('customer-name').value === 'Příklad s.r.o.');
      expect(field('customer-name').value).toBe('Příklad s.r.o.');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({ ico: validIco });
      expect(field('customer-vat-id').value).toBe(`CZ${validIco}`);
      expect(field('customer-city').value).toBe('Praha');
      expect(field('customer-postal-code').value).toBe('120 00');
      expect(screen.getByText(copy(`${KEY}.aresDone`))).toBeTruthy();
      // Editing another field never repeats the lookup of the same IČO.
      yield* type('customer-email', 'obchod@priklad.cz');
      yield* passFakeTime('800 millis', { between: networkIdle });
      expect(requests).toHaveLength(1);
    }),
  );

  suite.effect('a wrong checksum is reported at once and never reaches ARES', () =>
    Effect.gen(function* checksum() {
      yield* pinTestDocument;
      yield* renderDialog();
      yield* type('customer-ico', '27082441');
      expect(screen.getByText(copy(`${KEY}.validation.icoChecksum`))).toBeTruthy();
      yield* passFakeTime('800 millis', { between: networkIdle });
      expect(requests).toHaveLength(0);
    }),
  );

  suite.effect('the lookup shows its progress inline and keeps every field the user typed', () =>
    Effect.gen(function* keepsTypedFields() {
      const pending = yield* Deferred.make<typeof evidence>();
      answer = Deferred.await(pending);
      yield* pinTestDocument;
      yield* renderDialog();
      yield* type('customer-name', 'Moje firma');
      yield* type('customer-ico', validIco);
      yield* passFakeTime('800 millis');
      yield* waitUntilOnFakeTimers(() => screen.queryByText(copy(`${KEY}.aresLoading`)) !== null);
      expect(screen.getByText(copy(`${KEY}.aresLoading`))).toBeTruthy();
      yield* type('customer-street', 'Vlastní 1');
      yield* Deferred.succeed(pending, evidence);
      yield* waitUntilOnFakeTimers(() => field('customer-city').value === 'Praha');
      expect(field('customer-city').value).toBe('Praha');
      expect(field('customer-name').value).toBe('Moje firma');
      expect(field('customer-street').value).toBe('Vlastní 1');
      expect(field('customer-vat-id').value).toBe(`CZ${validIco}`);
      expect(screen.queryByText(copy(`${KEY}.aresLoading`))).toBeNull();
    }),
  );

  suite.effect('a quickly corrected IČO sends only the final one', () =>
    Effect.gen(function* debounce() {
      yield* pinTestDocument;
      yield* renderDialog();
      yield* type('customer-ico', '25596641');
      yield* passFakeTime('200 millis');
      yield* type('customer-ico', validIco);
      yield* passFakeTime('800 millis');
      yield* waitUntilOnFakeTimers(() => requests.length === 1);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({ ico: validIco });
    }),
  );
});
