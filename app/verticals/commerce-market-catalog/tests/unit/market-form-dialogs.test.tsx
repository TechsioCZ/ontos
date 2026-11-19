// @rstest-environment happy-dom
// Real market dialogs, i18n, router and Action clients; the owner's HTTP contracts answer in process.
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { StorefrontApplicationSummarySchema } from '@app/storefront-registry/api/storefront-applications';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { associateStorefrontActionSchemaErrorLive } from '../../api/associate-storefront-action-problems.ts';
import { createMarketActionSchemaErrorLive } from '../../api/create-market-action-problems.ts';
import { reviseMarketDefinitionActionSchemaErrorLive } from '../../api/revise-market-definition-action-problems.ts';
import { AssociateStorefrontResultSchema } from '../../shared/actions/associate-storefront.ts';
import { CreateMarketResultSchema } from '../../shared/actions/create-market.ts';
import { ReviseMarketDefinitionResultSchema } from '../../shared/actions/revise-market-definition.ts';
import { AssociateStorefrontActionApi } from '../../shared/apis/associate-storefront-action.ts';
import type { AssociateStorefrontPayloadSchema } from '../../shared/apis/associate-storefront-action.ts';
import { CreateMarketActionApi } from '../../shared/apis/create-market-action.ts';
import type { CreateMarketPayloadSchema } from '../../shared/apis/create-market-action.ts';
import { ReviseMarketDefinitionActionApi } from '../../shared/apis/revise-market-definition-action.ts';
import type { ReviseMarketDefinitionPayloadSchema } from '../../shared/apis/revise-market-definition-action.ts';
import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { EditMarketDialog } from '../../src/market-admin/market-dialogs.tsx';
import { NewMarketDialog } from '../../src/market-admin/new-market-dialog.tsx';
import type { NewMarketDialogProps } from '../../src/market-admin/new-market-dialog.tsx';
import { StorefrontsSection } from '../../src/market-admin/storefronts-section.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '30000000-0000-4000-8000-000000000001';

const market = Schema.decodeUnknownSync(MarketDefinitionSchema)({
  channels: ['B2C'],
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  effectivePeriod: { startsAt: '2026-01-01T00:00:00.000Z' },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
  lifecycle: 'ACTIVE',
  marketCode: 'CZ_B2C',
  marketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  purpose: 'Czech retail commerce',
  revision: 1,
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
});

const revised = Schema.decodeUnknownSync(ReviseMarketDefinitionResultSchema)({
  definitionRevisionRef: { ...market.definitionRevisionRef, resourceId: '77777777-7777-4777-8777-777777777777' },
  marketRef: market.marketRef,
  previousDefinitionRevisionRef: market.definitionRevisionRef,
  revision: 2,
});

const created = Schema.decodeUnknownSync(CreateMarketResultSchema)({
  created: true,
  definitionRevisionRef: market.definitionRevisionRef,
  marketRef: market.marketRef,
  revision: 1,
});

const associated = Schema.decodeUnknownSync(AssociateStorefrontResultSchema)({
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  changed: true,
  marketRef: market.marketRef,
  revision: 1,
});

const storefront = Schema.decodeUnknownSync(StorefrontApplicationSummarySchema)({
  allowedChannels: ['B2C'],
  effectiveInterval: { effectiveFrom: '2026-01-01T00:00:00.000Z' },
  lifecycle: 'ACTIVE',
  revision: 1,
  storefrontAppId: 'shop-b2c',
  storefrontApplicationRef: {
    moduleId: 'commerce.storefront-registry',
    resourceId: '77777777-7777-4777-8777-777777777771',
    resourceType: 'commerce.storefront-registry.storefront-application',
    tenantId,
  },
});

const revisions: (typeof ReviseMarketDefinitionPayloadSchema.Encoded)[] = [];
const creations: (typeof CreateMarketPayloadSchema.Encoded)[] = [];
const associations: (typeof AssociateStorefrontPayloadSchema.Encoded)[] = [];
const RevisionApi = ReviseMarketDefinitionActionApi.prefix('/commerce-market-catalog-api');
const CreationApi = CreateMarketActionApi.prefix('/commerce-market-catalog-api');
const AssociationApi = AssociateStorefrontActionApi.prefix('/commerce-market-catalog-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'commerce-market-catalog': '/commerce-market-catalog-api' }).application,
  serveApi(
    RevisionApi,
    HttpApiBuilder.group(RevisionApi, 'reviseMarketDefinitionAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          revisions.push(payload);
          return revised;
        }),
      ),
    ).pipe(Layer.provide(reviseMarketDefinitionActionSchemaErrorLive)),
  ),
  serveApi(
    CreationApi,
    HttpApiBuilder.group(CreationApi, 'createMarketAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          creations.push(payload);
          return created;
        }),
      ),
    ).pipe(Layer.provide(createMarketActionSchemaErrorLive)),
  ),
  serveApi(
    AssociationApi,
    HttpApiBuilder.group(AssociationApi, 'associateStorefrontAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          associations.push(payload);
          return associated;
        }),
      ),
    ).pipe(Layer.provide(associateStorefrontActionSchemaErrorLive)),
  ),
);

const czech = moduleText('cs');
const keyOf = (path: string) => czech(`commerce-market-catalog.${path}`);

const buttonNamed = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const fieldById = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

/** Types like a user: React sees a native input event. */
const typeInto = (id: string, value: string) =>
  acted(() => {
    const field = fieldById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

const clickButton = (name: string) => acted(() => buttonNamed(name).click());
const isOpen = (text: string) => buttons(text).length > 0;

beforeEach(() => {
  revisions.length = 0;
  creations.length = 0;
  associations.length = 0;
});
afterEach(unmountAll);

describe('edit market dialog', () => {
  it.live('typing changes only the draft; Save revises the market once and reports it', () =>
    Effect.gen(function* editTypingSendsNothing() {
      yield* pinTestDocument;
      const done: string[] = [];
      const onDone = (message: string) => {
        done.push(message);
      };
      yield* mountInRoute(
        <EditMarketDialog market={market} onAwaitingApproval={constVoid} onClose={constVoid} onDone={onDone} />,
      );
      yield* typeInto('edit-market-purpose', 'Nový účel');
      yield* Effect.sleep('1 second');
      yield* networkIdle;
      expect(revisions.length).toBe(0);
      expect(buttonNamed('Uložit').disabled).toBe(true);

      yield* typeInto('edit-market-reason', 'Oprava názvu');
      expect(buttonNamed('Uložit').disabled).toBe(false);
      yield* networkIdle;
      expect(revisions.length).toBe(0);

      yield* clickButton('Uložit');
      yield* waitUntil(() => revisions.length > 0);
      yield* networkIdle;
      expect(revisions.length).toBe(1);
      yield* waitUntil(() => done.length > 0);
      expect(done).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('leaving with unsaved input asks first and sends nothing', () =>
    Effect.gen(function* editLeaveAsks() {
      yield* pinTestDocument;
      const closed: true[] = [];
      const onClose = () => {
        closed.push(true);
      };
      yield* mountInRoute(
        <EditMarketDialog market={market} onAwaitingApproval={constVoid} onClose={onClose} onDone={constVoid} />,
      );
      yield* typeInto('edit-market-purpose', 'Nový účel');
      yield* clickButton(keyOf('form.cancel'));
      expect(isOpen('Zůstat')).toBe(true);
      expect(isOpen('Zahodit změny')).toBe(true);
      expect(closed).toHaveLength(0);
      yield* networkIdle;
      expect(revisions.length).toBe(0);

      yield* clickButton('Zůstat');
      expect(closed).toHaveLength(0);
      yield* networkIdle;
      expect(revisions.length).toBe(0);
    }).pipe(Effect.provide(network)),
  );
});

describe('new market dialog', () => {
  it.live('typing changes only the draft; Save creates the market once', () =>
    Effect.gen(function* newMarketTypingSendsNothing() {
      yield* pinTestDocument;
      const createdResults: Parameters<NewMarketDialogProps['onCreated']>[0][] = [];
      const onCreated: NewMarketDialogProps['onCreated'] = (result) => {
        createdResults.push(result);
      };
      yield* mountInRoute(
        <NewMarketDialog
          canConfigurePricing={false}
          legalEntityId="33333333-3333-4333-8333-333333333333"
          merchandiseRevision={3}
          onClose={constVoid}
          onCreated={onCreated}
          tenantId={tenantId}
        />,
      );
      yield* typeInto('new-market-code', 'NEW_TRH');
      yield* typeInto('new-market-purpose', 'Nový trh');
      yield* typeInto('new-market-jurisdictions', 'CZ');
      yield* typeInto('new-market-locales', 'cs-CZ');
      yield* typeInto('new-market-valid-from', '2026-11-10');
      yield* Effect.sleep('1 second');
      yield* networkIdle;
      expect(creations.length).toBe(0);
      expect(buttonNamed('Uložit').disabled).toBe(false);

      yield* clickButton('Uložit');
      yield* waitUntil(() => creations.length > 0);
      yield* networkIdle;
      expect(creations.length).toBe(1);
      yield* waitUntil(() => createdResults.length > 0);
      expect(createdResults).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('leaving with unsaved input asks first', () =>
    Effect.gen(function* newMarketLeaveAsks() {
      yield* pinTestDocument;
      const closed: true[] = [];
      const onClose = () => {
        closed.push(true);
      };
      yield* mountInRoute(
        <NewMarketDialog
          canConfigurePricing={false}
          legalEntityId="33333333-3333-4333-8333-333333333333"
          merchandiseRevision={3}
          onClose={onClose}
          onCreated={constVoid}
          tenantId={tenantId}
        />,
      );
      yield* typeInto('new-market-code', 'NEW_TRH');
      yield* clickButton(keyOf('form.cancel'));
      expect(isOpen('Zůstat')).toBe(true);
      expect(closed).toHaveLength(0);
      yield* networkIdle;
      expect(creations.length).toBe(0);
    }).pipe(Effect.provide(network)),
  );
});

const section = (onDone: (message: string) => void) => (
  <StorefrontsSection
    associations={[]}
    canAdminister
    market={market}
    onAwaitingApproval={constVoid}
    onDone={onDone}
    storefronts={[storefront]}
  />
);

describe('storefront association dialog', () => {
  it.live('typing changes only the draft; Save associates the e-shop once', () =>
    Effect.gen(function* associationTypingSendsNothing() {
      yield* pinTestDocument;
      const done: string[] = [];
      const onDone = (message: string) => {
        done.push(message);
      };
      yield* mountInRoute(section(onDone));
      yield* clickButton(keyOf('detail.storefronts.associate'));
      yield* typeInto('association-valid-from', '2026-11-10');
      yield* Effect.sleep('1 second');
      yield* networkIdle;
      expect(associations.length).toBe(0);

      yield* clickButton('Uložit');
      yield* waitUntil(() => associations.length > 0);
      yield* networkIdle;
      expect(associations.length).toBe(1);
      yield* waitUntil(() => done.length > 0);
      expect(done).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('the pre-selected e-shop saves without typing; leaving untouched asks nothing', () =>
    Effect.gen(function* associationDefaultsSave() {
      yield* pinTestDocument;
      yield* mountInRoute(section(constVoid));
      yield* clickButton(keyOf('detail.storefronts.associate'));
      expect(buttonNamed('Uložit').disabled).toBe(false);
      yield* clickButton(keyOf('form.cancel'));
      expect(isOpen('Zůstat')).toBe(false);

      yield* clickButton(keyOf('detail.storefronts.associate'));
      yield* clickButton('Uložit');
      yield* waitUntil(() => associations.length > 0);
      yield* networkIdle;
      expect(associations.length).toBe(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('leaving with unsaved input asks first', () =>
    Effect.gen(function* associationLeaveAsks() {
      yield* pinTestDocument;
      yield* mountInRoute(section(constVoid));
      yield* clickButton(keyOf('detail.storefronts.associate'));
      yield* typeInto('association-valid-from', '2026-11-10');
      yield* clickButton(keyOf('form.cancel'));
      expect(isOpen('Zůstat')).toBe(true);
      yield* networkIdle;
      expect(associations.length).toBe(0);
    }).pipe(Effect.provide(network)),
  );
});
