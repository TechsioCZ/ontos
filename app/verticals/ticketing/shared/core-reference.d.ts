import { Schema } from '@modern-js/plugin-bff/effect-client';
import type { CoreReference, CoreReferenceInsertionResult, CoreReferenceOpenResult, CoreReferenceResolutionResult, DiscoveredCoreReference } from '@app/core-runtime/core-reference';
export declare const coreReferenceSchema: Schema.Schema<CoreReference>;
export declare const coreReferenceRequestSchema: Schema.Union<readonly [Schema.Struct<{
    readonly operation: Schema.Literal<"discover">;
    readonly query: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literals<readonly ["mention", "relation"]>;
    readonly operation: Schema.Literal<"insert">;
    readonly source: Schema.Union<readonly [Schema.Struct<{
        readonly type: Schema.Literal<"deepLink">;
        readonly value: Schema.String;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"opaqueToken">;
        readonly value: Schema.String;
    }>]>;
}>, Schema.Struct<{
    readonly operation: Schema.Literal<"resolve">;
    readonly reference: Schema.Schema<CoreReference>;
}>, Schema.Struct<{
    readonly operation: Schema.Literal<"open">;
    readonly reference: Schema.Schema<CoreReference>;
}>]>;
export declare const coreReferenceResponseSchema: Schema.Union<readonly [Schema.Struct<{
    readonly operation: Schema.Literal<"discover">;
    readonly references: Schema.$Array<Schema.Schema<DiscoveredCoreReference>>;
}>, Schema.Struct<{
    readonly operation: Schema.Literal<"insert">;
    readonly result: Schema.Schema<CoreReferenceInsertionResult>;
}>, Schema.Struct<{
    readonly operation: Schema.Literal<"resolve">;
    readonly result: Schema.Schema<CoreReferenceResolutionResult>;
}>, Schema.Struct<{
    readonly operation: Schema.Literal<"open">;
    readonly result: Schema.Schema<CoreReferenceOpenResult>;
}>]>;
export type CoreReferenceRequest = typeof coreReferenceRequestSchema.Type;
export type CoreReferenceResponse = typeof coreReferenceResponseSchema.Type;
