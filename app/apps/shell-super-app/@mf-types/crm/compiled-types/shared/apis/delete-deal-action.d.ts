import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const DeleteDealPayloadSchema: Schema.Struct<{
    readonly dealId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>;
export type DeleteDealPayload = typeof DeleteDealPayloadSchema.Type;
export declare const DeleteDealResultSchema: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly dealId: Schema.String;
    readonly deletedAt: Schema.String;
    readonly version: Schema.Finite;
}>;
export type DeleteDealResult = typeof DeleteDealResultSchema.Type;
export declare const DeleteDealValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteDealActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const DeleteDealSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<DeleteDealSchemaErrorMiddleware, "crm.core/delete-deal/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"DeleteDealValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class DeleteDealSchemaErrorMiddleware extends DeleteDealSchemaErrorMiddleware_base {
}
export declare const DeleteDealActionApi: HttpApi.HttpApi<"DeleteDealActionApi", HttpApiGroup.HttpApiGroup<"deleteDealActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/delete-deal", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly dealId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly dealId: Schema.String;
    readonly deletedAt: Schema.String;
    readonly version: Schema.Finite;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteDealUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, DeleteDealSchemaErrorMiddleware, never>, false>>;
export {};
