import { SYMMY_REST_PREFIX, SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import type { SymmyRouteKey } from '@app/shared-contracts/symmy';
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import { Layer, Result, Schema } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { HttpApiScalar, OpenApi } from 'effect/http-api';

import { SymmyIngressGroup } from '../../shared/api.ts';

/** Where a Symmy developer reads the API: the Scalar page and the OpenAPI document it renders. */
export const SYMMY_DOCS_PATH = `${SYMMY_REST_PREFIX}/docs` as const;
export const SYMMY_OPENAPI_PATH = `${SYMMY_REST_PREFIX}/openapi.json` as const;

const apiKeyScheme = 'SymmyApiKey';

const tenantId = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const catalogModuleId = 'commerce.catalog';
const jsonMediaType = 'application/json';
const priceListsTag = 'Price lists';
const pieceUnitRef = {
  moduleId: catalogModuleId,
  resourceId: '43d5c797-2b36-4877-85ad-caac3a674d9c',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const wholesalePriceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '64cc6324-0de4-418d-bbec-7fe26077db8c',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
};

const guide = `Send AKROS ERP data to OntOS: products, texts, item numbers, prices, stock, customer groups and price lists.

This is the **Akros demo stage**. Everything on this page can be tried from the browser: paste your key under
**Authentication**, open an operation and press **Test Request**.

## 1. Every call

| Header | Value |
| --- | --- |
| \`x-api-key\` | Your API key. |
| \`idempotency-key\` | Required on every \`POST\`: any text you choose, new for each new request (1 to 200 characters of \`a-z A-Z 0-9 . _ -\`). |
| \`content-type\` | \`application/json\` |

Repeating a \`POST\` with the same \`idempotency-key\` and the same body is safe: it returns the saved result and
writes nothing twice. A changed body needs a new key.

## 2. First run

1. \`POST /products/batch\` with one product. The answer is \`202\` with a \`jobId\`.
2. \`GET /jobs/{id}\` until \`status\` starts with \`completed\`. A job can read \`indeterminate\` for a few seconds first.
3. Look at the result: \`GET /admin/products\`, or the shop page
   [ontos-stage-akros.web-revolution.cz/cs/novinky-z-erp](https://ontos-stage-akros.web-revolution.cz/cs/novinky-z-erp).
4. Send stock with \`POST /inventory/stock/batch\` and a new price by sending the product again.

## 3. Reading a result

Each sent item answers with an \`outcome\` (\`accepted\`, \`partial\`, \`not_accepted\`) and one entry per written part:

| \`status\` | Meaning |
| --- | --- |
| \`accepted_change\` | Written, the value changed. |
| \`accepted_no_change\` | OntOS already held this value. |
| \`duplicate\` | Already accepted earlier, for example the product was created by a previous request. |
| \`waiting\`, \`executing\`, \`indeterminate\` | Not settled yet, read the job again. |
| \`conflict\`, \`invalid\`, \`denied\`, \`stale\` | Refused. |
| \`unsupported\` | OntOS cannot write this part yet, the rest of the item still runs. |

## 4. Refusals

Every refusal is \`application/problem+json\` with \`title\`, \`status\` and \`detail\`.

| Status | Meaning |
| --- | --- |
| 400 | The body breaks the schema or a limit, for example more than 16 items in one request. |
| 401 | \`x-api-key\` is missing or not valid. |
| 403 | The key may not do this, or a stock row names an item that is not prepared. |
| 409 | This \`idempotency-key\` was already used with a different body. |
| 428 | \`idempotency-key\` is missing. |
| 429 | Too many requests, retry later. |
| 503 | Temporarily unavailable, retry the same body with a new key. |

## 5. Limits of the demo

- **Prices and stock** are accepted for the twelve prepared items: \`AKROS-10001-V1\` to \`AKROS-10009-V1\`,
  \`AKROS-DEMO-0001-V1\`, \`AKROS-DEMO-0002-V1\` and \`AKROS-DEMO-0002-V2\`. A new product, its texts and its item
  number go through at once; its price and stock need a one-time preparation on the OntOS side, so tell us which
  item you want to add.
- **Wholesale list prices** are prepared for \`AKROS-10001-V1\` to \`AKROS-10004-V1\` in the list \`VELKOOBCHOD\`.
- **Not available yet:** customers, customer-group members, images, categories, and orders going back to the ERP.
`;

type Json = typeof Schema.Json.Type;

interface DocumentedRoute {
  readonly description: string;
  readonly requestExamples?: Readonly<Record<string, { readonly summary: string; readonly value: Json }>>;
  readonly responseExample?: Json;
  readonly summary: string;
  readonly tag: 'Customer groups' | 'Jobs' | 'Products' | 'Stock' | typeof priceListsTag;
}

const queuedJob = { jobId: 'bea5c936-20ba-4570-99f4-1207c6472617', status: 'queued' };
const testProductName = 'Šroub s půlkulatou hlavou M6×20';

/** The routes that work on the Akros stage. Every other route stays undocumented. */
export const symmyDocumentedRoutes = {
  adminProducts: {
    description: `The products OntOS holds from your requests, with the OntOS references you need for price lists
(\`product.productRef\` and \`variantSources[].variantId\`).

\`fields\` is a comma-separated selection, for example \`product.name,variantSources\`.`,
    summary: 'List the products that arrived',
    tag: 'Products',
  },
  customerGroupsBatch: {
    description: `Defines customer groups. A group carries no price and no member by itself. All seven fields are required,
at most 16 groups per request. The answer is \`200\` with one result per group.`,
    requestExamples: {
      group: {
        summary: 'One customer group',
        value: {
          customerGroups: [
            {
              businessCode: 'MO',
              code: 'MALOOBCHOD',
              description: 'Maloobchodní zákazníci AKROS',
              meaningKey: 'akros.retail-customers',
              membershipCriteria: 'Zákazníci, kterým AKROS ERP přiřadil maloobchodní skupinu MO',
              name: 'Maloobchod',
              purpose: 'Maloobchodní ceny a podmínky AKROS řízené z ERP',
            },
          ],
        },
      },
    },
    summary: 'Send customer groups',
    tag: 'Customer groups',
  },
  inventoryStockBatch: {
    description: `One row is the quantity on hand of one item in one warehouse. Send the whole quantity, not a change.

- \`itemKey\`: the ERP id of the variant, as sent in \`products/batch\`.
- \`locationKey\`: the warehouse, \`AKROS-SKLAD-1\`.
- \`quantity.amount\`: a decimal text without a sign and without trailing zeros (\`"2500"\`, \`"12.5"\`).
- \`quantity.unitRef\`: the OntOS unit „ks“. Copy it from the example unchanged.
- \`revision\` and \`sourceReference\`: your revision of the figure and your reference for tracing.

The answer is \`200\` with one result per row, in the order sent. At most 16 rows per request. One row for an item
that is not prepared refuses the whole request with \`403\`.`,
    requestExamples: {
      stock: {
        summary: 'Stock of one item',
        value: {
          stock: [
            {
              businessObservedAt: '2026-11-21T19:00:00.000Z',
              itemKey: 'AKROS-10001-V1',
              locationKey: 'AKROS-SKLAD-1',
              quantity: { amount: '2400', unitRef: pieceUnitRef },
              revision: '2',
              sourceReference: 'erp:akros:stock:AKROS-10001-V1:2',
            },
          ],
        },
      },
    },
    summary: 'Send stock',
    tag: 'Stock',
  },
  job: {
    description: `The result of a request that answered \`202\`.

\`status\` is \`queued\`, \`running\` or \`blocked\` while the job runs, then \`completed_all\`, \`completed_partial\` or
\`completed_none\`. A job can read \`indeterminate\` for a few seconds before it settles: read it again.`,
    responseExample: {
      items: [
        {
          effects: [
            { originalStatus: 'accepted_change', owner: catalogModuleId, status: 'duplicate' },
            { owner: catalogModuleId, status: 'accepted_no_change' },
            { owner: 'commerce.pricing', status: 'accepted_change' },
          ],
          itemId: '88baf444-3439-4a78-b1b1-e9a09bef4751',
          outcome: 'accepted',
        },
      ],
      jobId: '7fa67c27-4a1f-4798-ba7e-7880ed781657',
      status: 'completed_all',
    },
    summary: 'Read the result of a job',
    tag: 'Jobs',
  },
  priceListPricesBatch: {
    description: `Sends the prices of one price list: 1 to 16 prices per request.

- \`priceGroupRef\`: the list, from \`GET /price-lists\`.
- \`operation\`: always \`DEFINE\`. To change a price, send \`DEFINE\` again with the new amount and a later
  \`effectiveFrom\`. Do not use \`REVISE\`.
- \`productRef\` and \`variantRef\`: the OntOS references from \`GET /admin/products\`.
- \`commercialScope\` and \`unitBasis\`: copy them from the example unchanged.

A signed-in shop customer who belongs to the list's group sees this price as „Vaše cena“.`,
    requestExamples: {
      price: {
        summary: 'A wholesale price of AKROS-10001-V1',
        value: {
          priceGroupRef: wholesalePriceGroupRef,
          prices: [
            {
              amount: '2.25',
              commercialScope: { channelId: 'B2C', marketId: 'e57c614d-3911-5a52-941e-29168b1db5e4' },
              currencyCode: 'CZK',
              effectiveFrom: '2026-12-01T08:00:00.000Z',
              operation: 'DEFINE',
              productRef: {
                moduleId: catalogModuleId,
                resourceId: '7ca0b79d-4dd3-4181-905e-36f80d7a0d10',
                resourceType: 'commerce.catalog.product',
                tenantId,
              },
              unitBasis: { quantity: '1', unitRef: pieceUnitRef },
              variantRef: {
                moduleId: catalogModuleId,
                resourceId: '5bc6a796-01b0-5f65-b700-3e944d29153c',
                resourceType: 'commerce.catalog.variant',
                tenantId,
              },
            },
          ],
        },
      },
    },
    responseExample: queuedJob,
    summary: 'Send the prices of a price list',
    tag: priceListsTag,
  },
  priceLists: {
    description: `The price lists with their \`priceGroupRef\`. With \`priceLimit\` each list also carries its prices.`,
    summary: 'List the price lists',
    tag: priceListsTag,
  },
  priceListsBatchUpsert: {
    description: `Creates a price list: a second set of prices for the customers of one group.

\`effectiveFrom\` must be in the future, one or two minutes ahead is enough. A start in the past is refused. A list is
only ever created; it has no end date.

After the job completes, read the list's \`priceGroupRef\` from \`GET /price-lists\`: you need it to send prices.`,
    requestExamples: {
      list: {
        summary: 'A new price list (move effectiveFrom into the future)',
        value: {
          priceLists: [
            {
              businessCode: 'PARTNER',
              code: 'PARTNER',
              description: 'Partnerský ceník AKROS pro smluvní odběratele.',
              effectiveFrom: '2026-12-01T08:00:00.000Z',
              name: 'Partner',
              purpose: 'Partnerské ceny pro smluvní odběratele AKROS.',
            },
          ],
        },
      },
    },
    responseExample: queuedJob,
    summary: 'Create price lists',
    tag: priceListsTag,
  },
  productsBatch: {
    description: `One ERP item is one product with one variant. Prices, stock and the item number belong to the variant.

- \`identifier\`: your ERP id of the product (\`erpId\`) and of the variant (\`variantId\`). They never change.
- \`name\`: required. It is written when the product is created; send the same name on every later request.
- \`localized\`: the texts the shop shows. Send locale \`cs\`.
- \`variants[].sku\`: the ERP item number. It is unique in OntOS, and a replaced number can never be used again.
- \`variants[].prices\`: the price before VAT as a decimal text, for example \`"125.50"\`, with \`currencyCode\` \`CZK\`.

**To change** texts, the item number or the price, send the product again with the same identifiers and a new
\`idempotency-key\`.

**Limit:** 16 items per request. A product counts as one, its variant as one more when it carries texts or an item
number, and each price as one more. Five products with texts and a price fit in one request.

Leave out every other field of the schema (\`lifecycle\`, \`gtin\`, \`categories\`, \`media\`, \`brand\` and so on):
OntOS does not write them yet.`,
    requestExamples: {
      newProduct: {
        summary: 'A new product with texts and an item number',
        value: {
          products: [
            {
              identifier: { type: 'erpId', value: 'SYMMY-TEST-0001' },
              localized: [{ description: 'Zkušební produkt odeslaný ze Symmy.', locale: 'cs', name: testProductName }],
              name: testProductName,
              variants: [
                {
                  identifier: { type: 'variantId', value: 'SYMMY-TEST-0001-V1' },
                  localized: [{ locale: 'cs', name: testProductName }],
                  sku: 'SYMMY-TEST-M6X20',
                },
              ],
            },
          ],
        },
      },
      priceChange: {
        summary: 'A new price for a prepared item',
        value: {
          products: [
            {
              identifier: { type: 'erpId', value: 'AKROS-10005' },
              name: 'Kotva ocelová M10×100',
              variants: [
                {
                  identifier: { type: 'variantId', value: 'AKROS-10005-V1' },
                  prices: [{ amount: '18.90', currencyCode: 'CZK' }],
                },
              ],
            },
          ],
        },
      },
    },
    responseExample: queuedJob,
    summary: 'Send products, texts, item numbers and prices',
    tag: 'Products',
  },
} satisfies Partial<Readonly<Record<SymmyRouteKey, DocumentedRoute>>>;

/** The order a sender meets the routes in. */
const documentedOrder = [
  'productsBatch',
  'job',
  'adminProducts',
  'inventoryStockBatch',
  'customerGroupsBatch',
  'priceListsBatchUpsert',
  'priceLists',
  'priceListPricesBatch',
] as const satisfies readonly (keyof typeof symmyDocumentedRoutes)[];

const tags = [
  { description: 'Products, their texts, item numbers and prices.', name: 'Products' },
  { description: 'The result of every request that answered 202.', name: 'Jobs' },
  { description: 'Quantities on hand.', name: 'Stock' },
  { description: 'Customer groups of the ERP.', name: 'Customer groups' },
  { description: 'Price lists and their prices, for example wholesale.', name: priceListsTag },
];

// The parts of the generated document this module rewrites; every other field passes through unchanged.
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const MediaTypes = Schema.Record(Schema.String, Fields);
const GeneratedOperationSchema = Schema.StructWithRest(
  Schema.Struct({
    parameters: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [Fields])),
    requestBody: Schema.optionalKey(Schema.StructWithRest(Schema.Struct({ content: MediaTypes }), [Fields])),
    responses: Schema.Record(
      Schema.String,
      Schema.StructWithRest(Schema.Struct({ content: Schema.optionalKey(MediaTypes) }), [Fields]),
    ),
  }),
  [Fields],
);
const GeneratedSpecSchema = Schema.StructWithRest(
  Schema.Struct({
    components: Fields,
    paths: Schema.Record(Schema.String, Schema.Record(Schema.String, GeneratedOperationSchema)),
  }),
  [Fields],
);
const decodeGeneratedSpec = Schema.decodeUnknownResult(GeneratedSpecSchema);

const apiKeySecurity = [{ [apiKeyScheme]: [] }];

const describeOperation = (
  operation: typeof GeneratedOperationSchema.Type,
  route: DocumentedRoute,
  successStatus: number,
) => ({
  ...operation,
  description: route.description,
  parameters: operation.parameters.filter(({ name }) => name !== 'x-api-key'),
  requestBody:
    operation.requestBody === undefined || route.requestExamples === undefined
      ? operation.requestBody
      : {
          ...operation.requestBody,
          content: {
            ...operation.requestBody.content,
            [jsonMediaType]: { ...operation.requestBody.content[jsonMediaType], examples: route.requestExamples },
          },
        },
  responses: Object.fromEntries(
    Object.entries(operation.responses).map(([status, response]) => [
      status,
      status !== String(successStatus) || response.content === undefined || route.responseExample === undefined
        ? response
        : {
            ...response,
            content: {
              ...response.content,
              [jsonMediaType]: { ...response.content[jsonMediaType], example: route.responseExample },
            },
          },
    ]),
  ),
  security: apiKeySecurity,
  summary: route.summary,
  tags: [route.tag],
});

const describeSpec = (generated: typeof Fields.Type) => {
  // A generated document of another shape is a defect of this module, caught by its unit test.
  const spec = Result.getOrThrow(decodeGeneratedSpec(generated));
  return {
    ...spec,
    components: {
      ...spec.components,
      securitySchemes: { [apiKeyScheme]: { in: 'header', name: 'x-api-key', type: 'apiKey' } },
    },
    paths: Object.fromEntries(
      documentedOrder.flatMap((key) => {
        const { method, path, successStatus } = SYMMY_ROUTES[key];
        const verb = method.toLowerCase();
        const operation = spec.paths[path]?.[verb];
        return operation === undefined
          ? []
          : [[path, { [verb]: describeOperation(operation, symmyDocumentedRoutes[key], successStatus) }]];
      }),
    ),
    security: apiKeySecurity,
    tags,
  };
};

/**
 * The public Symmy API as Symmy's developers read it: the routes that work on the Akros stage, each with a plain
 * description and a request that can be sent as it stands. Schemas come from the same group the handlers serve.
 */
export const SymmyDocsApi = HttpApi.make('symmyDocsApi')
  .add(SymmyIngressGroup.annotate(OpenApi.Exclude, false))
  .annotate(OpenApi.Title, 'Symmy → OntOS API (Akros demo)')
  .annotate(OpenApi.Version, '1')
  .annotate(OpenApi.Description, guide)
  .annotate(OpenApi.Transform, describeSpec);

/** The Scalar page and the OpenAPI document, served under the Symmy mount without a key. */
export const SymmyDocsLive = Layer.mergeAll(
  HttpApiScalar.layer(SymmyDocsApi, {
    path: SYMMY_DOCS_PATH,
    scalar: {
      authentication: { preferredSecurityScheme: apiKeyScheme },
      defaultOpenAllTags: true,
      hideModels: true,
      layout: 'modern',
    },
  }),
  HttpRouter.add('GET', SYMMY_OPENAPI_PATH, HttpServerResponse.jsonUnsafe(OpenApi.fromApi(SymmyDocsApi))),
);
