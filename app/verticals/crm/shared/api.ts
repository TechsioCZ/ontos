import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { ChangeCustomerPrimaryContactActionApi } from './apis/change-customer-primary-contact-action.ts';
import { ContactDetailApi } from './apis/contact-detail.ts';
import { CreateContactActionApi } from './apis/create-contact-action.ts';
import { CreateCustomerActionApi } from './apis/create-customer-action.ts';
import { CustomerDetailApi } from './apis/customer-detail.ts';
import { CustomerDirectoryApi } from './apis/customer-directory.ts';
import { CustomerTimelineApi } from './apis/customer-timeline.ts';
import { DealDetailApi } from './apis/deal-detail.ts';
import { DeleteContactActionApi } from './apis/delete-contact-action.ts';
import { DeleteCustomerActionApi } from './apis/delete-customer-action.ts';
import { EditContactActionApi } from './apis/edit-contact-action.ts';
import { EditCustomerActionApi } from './apis/edit-customer-action.ts';

export interface CrmMarker {
  readonly appId: string;
  readonly build: string;
  readonly buildMarker: string;
  readonly deployProfile: string;
  readonly packageName: string;
  readonly sourceRevision: string;
  readonly surface: string;
  readonly unitId: string;
  readonly version: string;
}

export interface CrmReadiness {
  readonly checks: {
    readonly api: 'ready';
    readonly moduleFederation: 'ready';
    readonly ssr: 'ready';
    readonly translations: 'ready';
  };
  readonly marker: CrmMarker;
  readonly status: 'ready';
  readonly versionSkew: 'none';
}

export const crmMarkerSchema: Schema.Codec<CrmMarker> = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  buildMarker: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  sourceRevision: Schema.String,
  surface: Schema.String,
  unitId: Schema.String,
  version: Schema.String,
});

export const crmReadinessSchema: Schema.Codec<CrmReadiness> = Schema.Struct({
  checks: Schema.Struct({
    api: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: crmMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
  traceId?: string;
}

export const crmFoundationApi = HttpApi.make('CrmFoundationApi').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/crm/readiness', {
      success: crmReadinessSchema,
    }),
  ),
);

export const crmApi = HttpApi.make('CrmApi')
  .addHttpApi(crmFoundationApi)
  .addHttpApi(ChangeCustomerPrimaryContactActionApi)
  .addHttpApi(ContactDetailApi)
  .addHttpApi(CreateContactActionApi)
  .addHttpApi(CreateCustomerActionApi)
  .addHttpApi(CustomerDetailApi)
  .addHttpApi(CustomerDirectoryApi)
  .addHttpApi(CustomerTimelineApi)
  .addHttpApi(DealDetailApi)
  .addHttpApi(DeleteContactActionApi)
  .addHttpApi(DeleteCustomerActionApi)
  .addHttpApi(EditContactActionApi)
  .addHttpApi(EditCustomerActionApi);

export const crmOperationContexts = {
  readiness: {
    method: 'GET',
    operationId: 'CrmApi:foundation:readiness',
    routePath: '/crm/readiness',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const crmApiContract = {
  apiPrefix: '/crm-api',
  basePath: '/crm-api/crm',
  ownerId: 'crm',
  readinessPath: '/crm-api/crm/readiness',
} as const;
