import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const CustomerDetailRequestSchema: Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.customer">;
}>;
export type CustomerDetailRequest = typeof CustomerDetailRequestSchema.Type;
export declare const CustomerDetailResponseSchema: Schema.Struct<{
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly label: Schema.String;
        readonly value: Schema.String;
    }>>;
    readonly title: Schema.String;
}>;
export type CustomerDetailResponse = typeof CustomerDetailResponseSchema.Type;
export declare const CustomerDetailValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDetailAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDetailUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDetailForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDetailNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDetailPolicyProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDetailPolicyConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDetailInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
declare const CustomerDetailSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<CustomerDetailSchemaErrorMiddleware, "crm.core/customer-detail/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"CustomerDetailValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class CustomerDetailSchemaErrorMiddleware extends CustomerDetailSchemaErrorMiddleware_base {
}
export declare const CustomerDetailApi: HttpApi.HttpApi<"CustomerDetailApi", HttpApiGroup.HttpApiGroup<"customerDetail", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/reads/customer-detail", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.customer">;
}>>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly label: Schema.String;
        readonly value: Schema.String;
    }>>;
    readonly title: Schema.String;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDetailInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, CustomerDetailSchemaErrorMiddleware, never>, false>>;
export {};
