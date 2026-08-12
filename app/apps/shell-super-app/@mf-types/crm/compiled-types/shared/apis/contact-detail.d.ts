import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
export declare const ContactDetailRequestSchema: Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.contact">;
}>;
export type ContactDetailRequest = typeof ContactDetailRequestSchema.Type;
export declare const ContactDetailResponseSchema: Schema.Struct<{
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly label: Schema.String;
        readonly value: Schema.String;
    }>>;
    readonly title: Schema.String;
}>;
export type ContactDetailResponse = typeof ContactDetailResponseSchema.Type;
export declare const ContactDetailAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ContactDetailUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ContactDetailForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ContactDetailNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ContactDetailPolicyProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ContactDetailPolicyConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ContactDetailInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ContactDetailApi: HttpApi.HttpApi<"ContactDetailApi", HttpApiGroup.HttpApiGroup<"contactDetail", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/reads/contact-detail", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly moduleId: Schema.Literal<"crm.core">;
    readonly resourceId: Schema.String;
    readonly resourceType: Schema.Literal<"crm.core.contact">;
}>>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly label: Schema.String;
        readonly value: Schema.String;
    }>>;
    readonly title: Schema.String;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ContactDetailInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, never, never>, false>>;
