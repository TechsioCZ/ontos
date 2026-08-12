import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const DealDetailRequestSchema: Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.deal">;
}>;
export type DealDetailRequest = typeof DealDetailRequestSchema.Type;
export declare const DealDetailResponseSchema: Schema.Struct<{
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly label: Schema.String;
        readonly value: Schema.String;
    }>>;
    readonly title: Schema.String;
}>;
export type DealDetailResponse = typeof DealDetailResponseSchema.Type;
export declare const DealDetailValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealDetailAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealDetailUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealDetailForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealDetailNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealDetailPolicyProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealDetailPolicyConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealDetailInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
declare const DealDetailSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<DealDetailSchemaErrorMiddleware, "crm.core/deal-detail/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"DealDetailValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class DealDetailSchemaErrorMiddleware extends DealDetailSchemaErrorMiddleware_base {
}
export declare const DealDetailRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
}>;
export declare const DealDetailApi: HttpApi.HttpApi<"DealDetailApi", HttpApiGroup.HttpApiGroup<"dealDetail", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/reads/deal-detail", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.deal">;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly label: Schema.String;
        readonly value: Schema.String;
    }>>;
    readonly title: Schema.String;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealDetailInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, DealDetailSchemaErrorMiddleware, never>, false>>;
export {};
