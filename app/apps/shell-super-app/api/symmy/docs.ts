import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import type { SymmyRouteKey } from '@app/shared-contracts/symmy';
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import { Effect, Layer } from 'effect';
import type { Schema } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { HttpApiScalar, OpenApi } from 'effect/http-api';

import { SymmyIngressGroup } from '../../shared/api.ts';

const apiKeyScheme = 'SymmyApiKey';

const tenantId = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const catalogModuleId = 'commerce.catalog';
const jsonMediaType = 'application/json';
const priceListsTag = 'Price lists';
const storefrontTag = 'Storefront catalog';
const customerGroupsTag = 'Customer groups';
const exampleCustomerId = 'ERP-CUSTOMER-0001';
/** These Shell endpoints are implemented outside the engineered SYMMY_ROUTES inventory. */
const demoRoutes = {
  demoCatalogProducts: { method: 'POST', path: '/api/symmy/v1/catalog/products/batch', successStatus: 200 },
  demoCatalogRevision: { method: 'GET', path: '/api/symmy/v1/catalog/revision', successStatus: 200 },
  demoCategories: { method: 'POST', path: '/api/symmy/v1/categories/batch', successStatus: 200 },
  demoMedia: { method: 'POST', path: '/api/symmy/v1/products/media', successStatus: 200 },
  demoOrder: { method: 'GET', path: '/api/symmy/v1/orders/{id}', successStatus: 200 },
  demoOrders: { method: 'GET', path: '/api/symmy/v1/orders', successStatus: 200 },
} as const;
const routeDefinitions = { ...SYMMY_ROUTES, ...demoRoutes };
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

const guide = `Exchange AKROS ERP data with OntOS: products, prices, stock, customers, groups, images, categories and order exports.

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
For a timeout, lost response, \`429\` or \`503\`, retry the same body with the same key. Do not generate a new key
just to retry an unfinished request.

## 2. First run

1. \`POST /products/batch\` with one product. The answer is \`202\` with a \`jobId\`.
2. \`GET /jobs/{id}\` until \`status\` starts with \`completed\`. A job can read \`indeterminate\` for a few seconds first.
3. Look at the result: \`GET /admin/products\`, or search the product's name or code in the shop
   [ontos-stage-akros.web-revolution.cz](https://ontos-stage-akros.web-revolution.cz/cs/vyhledavani).
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
| 403 | The key has no authority for this operation or selected company. |
| 409 | An idempotency key conflicts, or the native catalog revision changed. |
| 422 | A warehouse, unit or requested projection has no supported source mapping. |
| 428 | \`idempotency-key\` is missing. |
| 429 | Too many requests, retry later. |
| 503 | Temporarily unavailable, retry the same body with the same \`idempotency-key\`. |

## 5. Choose the product model

| API | Owner and identifiers |
| --- | --- |
| \`POST /products/batch\`, stock and price lists | Engineered Catalog. ERP identifiers resolve to typed \`productRef\`, \`variantRef\` and \`unitRef\` values. Read them with \`GET /admin/products\`. |
| \`POST /categories/batch\`, \`POST /catalog/products/batch\`, \`POST /products/media\` | Native demo Merchandise, the storefront catalog. Responses contain native \`entityId\` values and \`ownerModuleId: "demo.merchandise"\`. These IDs are not engineered Catalog references. |

New ERP SKUs do not need a manual per-SKU price or stock grant. The enrolled source policy still controls the
company, warehouse, unit and commercial dimensions, without a preseeded SKU allowlist.
Products, prices and stock you send through Symmy appear as ordinary products in OntOS "Produkty" and on the shop,
marked as imported through Symmy. You do not need to send them a second time.

For native storefront writes, read the current catalog revision with \`GET /catalog/revision\` first.
Copy its \`revision\` into the write's \`expectedRevision\`, then use the returned \`revision\` for your next write.
Replace the example revision \`0\` with the value you just read.
Create categories before products that name their \`categoryCode\`. Use the product's native \`entityId\` as
\`productId\` when uploading an image. A revision conflict requires a fresh catalog read, not a guessed revision.

## 6. Customers and order exports

\`POST /customers/batch\` imports people or organizations through Party Registry and Commerce Customer Context.
\`POST /customer-groups/{code}/customers/batch\` assigns previously imported ERP \`customerId\` values to one group.
Read customer results with \`GET /admin/customers\`. Personal data still requires the source's real Privacy authority.
A customer whose Party is archived or is no longer a current customer of the company is left out of its page, so a
page can hold fewer than \`limit\` customers; \`count\` still counts it. Page with \`offset += limit\` until \`offset >= count\`.

\`GET /orders\` and \`GET /orders/{id}\` export existing orders of the credential's selected company.
They do not create an invoice, push an order into ABRA, or confirm an ERP import.

## 7. Request limits

Batch limits, source authority, company boundaries, idempotency and rate limits still apply.
Native category and product requests accept 1 to 16 rows; a product has at most 20 image URL references.
Customer batches accept 1 to 16 customers within the owner execution-plan budget.
Order pages accept \`limit\` from 1 to 100 and a nonnegative \`offset\`.
Core Media validates image signatures and decoded byte limits. A URL reference does not make Shell download remote bytes.
`;

type Json = typeof Schema.Json.Type;

interface DocumentedRoute {
  readonly description: string;
  readonly requestExamples?: Readonly<Record<string, { readonly summary: string; readonly value: Json }>>;
  readonly responseExample?: Json;
  readonly summary: string;
  readonly tag:
    | 'Customers'
    | typeof customerGroupsTag
    | 'Jobs'
    | 'Orders'
    | 'Products'
    | 'Stock'
    | typeof priceListsTag
    | typeof storefrontTag;
}

const queuedJob = { jobId: 'bea5c936-20ba-4570-99f4-1207c6472617', status: 'queued' };
const testProductName = 'Šroub s půlkulatou hlavou M6×20';

/** The routes that work on the Akros stage. Every other route stays undocumented. */
export const symmyDocumentedRoutes = {
  adminCustomers: {
    description: `Read customers imported by this source. The response uses the public customer projection, not internal plans.`,
    summary: 'List imported customers',
    tag: 'Customers',
  },
  adminProducts: {
    description: `The products OntOS holds from your requests, with the OntOS references you need for price lists
(\`product.productRef\` and \`variantSources[].variantId\`).

\`fields\` is a comma-separated selection, for example \`product.name,variantSources\`.`,
    summary: 'List the products that arrived',
    tag: 'Products',
  },
  customerGroupCustomersBatch: {
    description: `Assign 1 to 16 customers to the group selected by the path's ERP code.
Each row names an ERP \`customerId\` previously sent through \`POST /customers/batch\`.
This assigns members; it does not replace the whole group or remove members. An unresolved customer is refused for its item.
The answer is \`202\`; read \`GET /jobs/{id}\`.`,
    requestExamples: {
      members: {
        summary: 'Assign an imported customer',
        value: { customers: [{ customerId: exampleCustomerId }] },
      },
    },
    responseExample: queuedJob,
    summary: 'Assign customers to a group',
    tag: customerGroupsTag,
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
    tag: customerGroupsTag,
  },
  customersBatch: {
    description: `Import 1 to 16 customers within the owner execution-plan budget. Use stable ERP \`customerId\` values.
\`kind: "ORGANIZATION"\` requires \`businessName\`; \`kind: "PERSON"\` requires \`firstName\` and \`lastName\`.
Contacts, official identifiers and saved addresses use the owners' validated schemas.
Personal-data writes require real source-processing authority; the API does not invent consent or a legal basis.
The answer is \`202\`; read \`GET /jobs/{id}\` for item outcomes.`,
    requestExamples: {
      organization: {
        summary: 'One organization identified by the ERP',
        value: {
          customers: [{ businessName: 'AKROS partner', customerId: exampleCustomerId, kind: 'ORGANIZATION' }],
        },
      },
    },
    responseExample: queuedJob,
    summary: 'Import customers',
    tag: 'Customers',
  },
  demoCatalogProducts: {
    description: `Create products in the actual native Merchandise storefront catalog, 1 to 16 per request.
Read \`GET /catalog/revision\` first and copy \`revision\` into \`expectedRevision\`.
Use the write response's \`revision\` for the next write.
\`priceMinor\` is an integer in minor currency units. \`categoryCode\` selects an imported ERP category;
\`categoryId\` selects a native category ID. Do not send both. \`images\` holds up to 20 allowed image URL references,
not base64 bytes. Stage accepts \`https://www.akros.cz/data/\` URLs and explicitly configured image hosts;
other hosts are refused. Shell does not fetch these URLs. Upload bytes with \`POST /products/media\`.
The response's native product \`entityId\` is not a Catalog \`productRef\` or \`variantRef\`.`,
    requestExamples: {
      product: {
        summary: 'Create a storefront product at the revision you just read',
        value: {
          expectedRevision: 0,
          products: [
            {
              active: true,
              category: 'Spojovací materiál',
              categoryCode: 'FASTENERS',
              description: 'Šroub dodaný z ERP.',
              lowStockThreshold: 5,
              name: testProductName,
              priceMinor: 12_550,
              published: true,
              sku: 'ERP-M6X20',
              slug: 'erp-m6x20',
              stockTracked: true,
              taxClassificationCode: 'cz.vat.standard',
              unit: 'ks',
            },
          ],
        },
      },
    },
    summary: 'Create native storefront products',
    tag: storefrontTag,
  },
  demoCatalogRevision: {
    description: `Read the current native Merchandise catalog revision for the credential's selected company.
The answer contains \`tenantId\`, \`legalEntityId\` and \`revision\`.
Copy \`revision\` into \`expectedRevision\` when creating categories, importing storefront products or uploading an image.
This is a read-only revision fence, not the engineered Catalog's product list.`,
    summary: 'Read the current storefront catalog revision',
    tag: storefrontTag,
  },
  demoCategories: {
    description: `Create native Merchandise categories from stable ERP \`code\` values, 1 to 16 per request.
Read \`GET /catalog/revision\` and copy \`revision\` into \`expectedRevision\` first.
Parents in the same batch must precede their children.
The response returns native category \`entityId\` values and the resulting catalog \`revision\`.
These IDs are not engineered Catalog references.`,
    requestExamples: {
      category: {
        summary: 'Create a native storefront category at the revision you just read',
        value: {
          categories: [
            {
              code: 'FASTENERS',
              name: 'Spojovací materiál',
              published: true,
              slug: 'spojovaci-material',
            },
          ],
          expectedRevision: 0,
        },
      },
    },
    summary: 'Create storefront categories',
    tag: storefrontTag,
  },
  demoMedia: {
    description: `Upload image bytes through Core Media and attach the verified image to a native Merchandise product.
Send its native \`productId\`, the \`revision\` from \`GET /catalog/revision\` as \`expectedRevision\`,
and \`image\` in the schema below.
Use \`image.filename\` and \`image.full.contentBase64\`; \`image.thumbnail\` is optional.
Core Media detects JPEG, PNG or WebP from the bytes. The full rendition is limited to 5 MiB,
the thumbnail to 512 KiB, and declared dimensions to 4096 pixels.
The response contains the new catalog \`revision\` and the stored image reference. This is not an engineered Catalog media reference.`,
    requestExamples: {
      image: {
        summary: 'A PNG image. Replace productId and expectedRevision with your current native values',
        value: {
          expectedRevision: 0,
          image: {
            filename: 'one-pixel.png',
            full: {
              contentBase64:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
              height: 1,
              width: 1,
            },
          },
          productId: 'native-product-id-from-catalog-import',
        },
      },
    },
    summary: 'Upload a storefront product image',
    tag: storefrontTag,
  },
  demoOrder: {
    description: `Read one existing native Merchandise order by its owner ID. The answer contains \`order\`.
An order outside the credential's company is not exposed. A missing order returns \`404\`.
This operation does not change the order or create an invoice.`,
    summary: 'Export one order',
    tag: 'Orders',
  },
  demoOrders: {
    description: `Read existing native Merchandise orders for the selected company. Page with \`limit\` (1 to 100) and
\`offset\`. The response contains \`orders\`, \`count\`, \`limit\` and \`offset\`.
Order IDs, lines, customer references, currency and monetary totals come from the owner.
This is a read-only export, not invoice creation or an ABRA push.`,
    summary: 'Export orders',
    tag: 'Orders',
  },
  inventoryStockBatch: {
    description: `One row is the quantity on hand of one item in one warehouse. Send the whole quantity, not a change.

- \`itemKey\`: the ERP id of the variant, as sent in \`products/batch\`.
- \`locationKey\`: the warehouse, \`AKROS-SKLAD-1\`.
- \`quantity.amount\`: a decimal text without a sign and without trailing zeros (\`"2500"\`, \`"12.5"\`).
- \`quantity.unitRef\`: the OntOS unit „ks“. Copy it from the example unchanged.
- \`revision\` and \`sourceReference\`: your revision of the figure and your reference for tracing.

The answer is \`200\` with one result per row, in the order sent. At most 16 rows per request.
The source policy provisions stock for new ERP item keys. A product or position that is not ready returns a retryable
\`503\`; an unknown warehouse or unit returns \`422\`. These are source and dependency checks, not a per-SKU allowlist.`,
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

This route writes engineered Catalog products. Its \`categories\` and \`media\` fields do not import native
storefront categories or image bytes. Use \`POST /categories/batch\`, \`POST /catalog/products/batch\` and
\`POST /products/media\` for the native Merchandise storefront catalog.`,
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
        summary: 'A new price for an ERP item',
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
} satisfies Partial<Readonly<Record<SymmyRouteKey | keyof typeof demoRoutes, DocumentedRoute>>>;

/** The order a sender meets the routes in. */
const documentedOrder = [
  'productsBatch',
  'job',
  'adminProducts',
  'inventoryStockBatch',
  'customersBatch',
  'adminCustomers',
  'customerGroupsBatch',
  'customerGroupCustomersBatch',
  'priceListsBatchUpsert',
  'priceLists',
  'priceListPricesBatch',
  'demoCatalogRevision',
  'demoCategories',
  'demoCatalogProducts',
  'demoMedia',
  'demoOrders',
  'demoOrder',
] as const satisfies readonly (keyof typeof symmyDocumentedRoutes)[];

const tags = [
  { description: 'Products, their texts, item numbers and prices.', name: 'Products' },
  { description: 'The result of every request that answered 202.', name: 'Jobs' },
  { description: 'Quantities on hand.', name: 'Stock' },
  { description: 'Customer groups of the ERP.', name: 'Customer groups' },
  { description: 'Customer imports and their source-owned projections.', name: 'Customers' },
  { description: 'Native Merchandise categories, products and Core Media images.', name: storefrontTag },
  { description: "Read-only export of the selected company's native orders.", name: 'Orders' },
  { description: 'Price lists and their prices, for example wholesale.', name: priceListsTag },
];

const apiKeySecurity = [{ [apiKeyScheme]: [] }];

const describeOperation = (operation: OpenApi.OpenAPISpecOperation, route: DocumentedRoute, successStatus: number) => ({
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
              [jsonMediaType]: {
                ...response.content[jsonMediaType],
                examples: { answer: { value: route.responseExample } },
              },
            },
          },
    ]),
  ),
  security: apiKeySecurity,
  summary: route.summary,
  tags: [route.tag],
});

const describeDocument = (generated: OpenApi.OpenAPISpec) => ({
  ...generated,
  components: {
    ...generated.components,
    securitySchemes: { [apiKeyScheme]: { in: 'header', name: 'x-api-key', type: 'apiKey' } },
  },
  paths: Object.fromEntries(
    documentedOrder.flatMap((key) => {
      const { method, path, successStatus } = routeDefinitions[key];
      const item = generated.paths[path];
      const operation = method === 'GET' ? item?.get : item?.post;
      if (operation === undefined) {
        return [];
      }
      const described = describeOperation(operation, symmyDocumentedRoutes[key], successStatus);
      return [[path, method === 'GET' ? { get: described } : { post: described }]];
    }),
  ),
  security: apiKeySecurity,
  tags,
});

// The handlers' own group, shown instead of hidden: its schemas are the ones the routes decode with.
const SymmyRoutesApi = HttpApi.make('symmyRoutesApi')
  .add(SymmyIngressGroup.annotate(OpenApi.Exclude, false))
  .annotate(OpenApi.Title, 'Symmy → OntOS API (Akros demo)')
  .annotate(OpenApi.Version, '1')
  .annotate(OpenApi.Description, guide);

/**
 * The public Symmy API as Symmy's developers read it: the routes that work on the Akros stage, each with a plain
 * description and schema-valid examples. Native writes require the current revision and the caller's own entity IDs.
 */
export const symmyOpenApiDocument = describeDocument(OpenApi.fromApi(SymmyRoutesApi));

// Scalar renders the document of the API it is given; this API's document is the described one.
const SymmyDocsApi = HttpApi.make('symmyDocsApi').annotate(OpenApi.Transform, () => symmyOpenApiDocument);

const serveOpenApi = Effect.fn('SymmyDocs.serveOpenApi')(function* serveSymmyOpenApi() {
  return yield* Effect.succeed(HttpServerResponse.jsonUnsafe(symmyOpenApiDocument));
});

/** The Scalar page and the OpenAPI document, served under the Symmy mount without a key. */
export const SymmyDocsLive = Layer.mergeAll(
  HttpApiScalar.layer(SymmyDocsApi, {
    path: '/api/symmy/v1/docs',
    scalar: {
      authentication: { preferredSecurityScheme: apiKeyScheme },
      defaultOpenAllTags: true,
      hideModels: true,
      layout: 'modern',
    },
  }),
  HttpRouter.add('GET', '/api/symmy/v1/openapi.json', serveOpenApi),
);
