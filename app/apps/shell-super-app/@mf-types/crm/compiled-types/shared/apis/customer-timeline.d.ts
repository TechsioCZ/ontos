import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
export declare const CustomerTimelineRequestSchema: Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.customer">;
}>;
export type CustomerTimelineRequest = typeof CustomerTimelineRequestSchema.Type;
export declare const CustomerTimelineResponseSchema: Schema.Struct<{
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly occurredAt: Schema.String;
        readonly summary: Schema.String;
        readonly timelineEntryId: Schema.String;
    }>>;
    readonly projectionLagging: Schema.Boolean;
}>;
export type CustomerTimelineResponse = typeof CustomerTimelineResponseSchema.Type;
export declare const CustomerTimelineAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerTimelineUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerTimelineForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerTimelineNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerTimelinePolicyProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelinePolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerTimelinePolicyConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelinePolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerTimelineInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerTimelineApi: HttpApi.HttpApi<"CustomerTimelineApi", HttpApiGroup.HttpApiGroup<"customerTimeline", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/reads/customer-timeline", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.customer">;
}>>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly occurredAt: Schema.String;
        readonly summary: Schema.String;
        readonly timelineEntryId: Schema.String;
    }>>;
    readonly projectionLagging: Schema.Boolean;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelinePolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelinePolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerTimelineInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, never, never>, false>>;
