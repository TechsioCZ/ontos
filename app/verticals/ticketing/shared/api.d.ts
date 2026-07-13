import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/plugin-bff/effect-client';
export type { CreateTicketActionFailure, CreateTicketActionOutcome, CreateTicketActionPayload, CreateTicketActionResponse, } from './actions/create-ticket';
export interface TicketingMarker {
    readonly appId: string;
    readonly build: string;
    readonly deployProfile: string;
    readonly packageName: string;
    readonly surface: string;
    readonly version: string;
}
export interface TicketingItem {
    readonly id: string;
    readonly marker: TicketingMarker;
    readonly title: string;
}
export interface TicketingReadiness {
    readonly checks: {
        readonly api: 'ready';
        readonly moduleFederation: 'ready';
        readonly ssr: 'ready';
        readonly translations: 'ready';
    };
    readonly marker: TicketingMarker;
    readonly status: 'ready';
    readonly versionSkew: 'none';
}
export interface TicketingCreatePayload {
    readonly title: string;
}
export interface TicketingListResponse {
    readonly items: readonly TicketingItem[];
}
export interface TicketingCreateResponse {
    readonly item: TicketingItem;
}
export interface TicketingNotFound {
    readonly _tag: 'TicketingNotFound';
    readonly id: string;
}
export declare const ticketingMarkerSchema: Schema.Codec<TicketingMarker>;
export declare const ticketingItemSchema: Schema.Codec<TicketingItem>;
export declare const ticketingReadinessSchema: Schema.Codec<TicketingReadiness>;
export declare const ticketingCreatePayloadSchema: Schema.Codec<TicketingCreatePayload>;
export declare const ticketingNotFoundSchema: Schema.Codec<TicketingNotFound>;
export interface OperationContext {
    method: string;
    operationId: string;
    routePath: string;
    source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
    traceId?: string;
}
export declare const ticketingApi: HttpApi.HttpApi<"TicketingApi", HttpApiGroup.HttpApiGroup<"ticketing", HttpApiEndpoint.HttpApiEndpoint<"create", "POST", "/ticketing", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Codec<TicketingCreatePayload, TicketingCreatePayload, never, never>>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly item: Schema.Codec<TicketingItem, TicketingItem, never, never>;
}>>, HttpApiEndpoint.Json<never>, never, never> | HttpApiEndpoint.HttpApiEndpoint<"createTicketAction", "POST", "/ticketing/actions/create-ticket", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly summary: Schema.String;
    readonly targetResourceId: Schema.String;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly 'Idempotency-Key': Schema.optional<Schema.String>;
    readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly actionInvocationId: Schema.optional<Schema.String>;
    readonly ok: Schema.Literal<true>;
    readonly response: Schema.Struct<{
        readonly accepted: Schema.Literal<true>;
        readonly actionKey: Schema.Literal<"ticketing.createTicket">;
        readonly message: Schema.String;
        readonly targetResourceId: Schema.String;
    }>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly code: Schema.optional<Schema.String>;
    readonly errorTag: Schema.String;
    readonly httpStatus: Schema.Finite;
    readonly message: Schema.String;
    readonly ok: Schema.Literal<false>;
    readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>>, never, never> | HttpApiEndpoint.HttpApiEndpoint<"get", "GET", "/ticketing/:id", HttpApiEndpoint.StringTree<Schema.Struct<{
    id: Schema.String;
}>>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Codec<TicketingItem, TicketingItem, never, never>>, HttpApiEndpoint.Json<Schema.Codec<TicketingNotFound, TicketingNotFound, never, never>>, never, never> | HttpApiEndpoint.HttpApiEndpoint<"list", "GET", "/ticketing", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<Schema.Struct<{
    limit: Schema.optional<Schema.FiniteFromString>;
}>>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly items: Schema.$Array<Schema.Codec<TicketingItem, TicketingItem, never, never>>;
}>>, HttpApiEndpoint.Json<never>, never, never> | HttpApiEndpoint.HttpApiEndpoint<"readiness", "GET", "/ticketing/readiness", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Codec<TicketingReadiness, TicketingReadiness, never, never>>, HttpApiEndpoint.Json<never>, never, never>, false>>;
export declare const ticketingOperationContexts: {
    create: {
        method: string;
        operationId: string;
        routePath: string;
        source: "generated-client";
    };
    createTicketAction: {
        method: string;
        operationId: string;
        routePath: string;
        source: "generated-client";
    };
    get: {
        method: string;
        operationId: string;
        routePath: string;
        source: "generated-client";
    };
    list: {
        method: string;
        operationId: string;
        routePath: string;
        source: "generated-client";
    };
    readiness: {
        method: string;
        operationId: string;
        routePath: string;
        source: "generated-client";
    };
};
export declare const ticketingApiContract: {
    readonly apiPrefix: '/ticketing-api';
    readonly basePath: '/ticketing-api/ticketing';
    readonly ownerId: 'ticketing';
    readonly readinessPath: '/ticketing-api/ticketing/readiness';
};
