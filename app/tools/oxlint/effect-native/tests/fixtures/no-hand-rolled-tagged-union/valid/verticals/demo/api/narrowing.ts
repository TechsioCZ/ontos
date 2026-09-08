import { Schema } from 'effect';

const ContactsProblemSchema = Schema.Union([
  Schema.TaggedStruct('ContactsInternalProblem', { status: Schema.Literal(500) }),
  Schema.TaggedStruct('ContactsForbiddenProblem', { status: Schema.Literal(403) }),
]);
export type ContactsProblem = Schema.Schema.Type<typeof ContactsProblemSchema>;

/** Audit-blessed: a query against the Schema-owned union, not a second declaration of it. */
export type ContactsInternalProblem = Extract<
  ContactsProblem,
  { readonly _tag: 'ContactsInternalProblem' }
>;
export type ContactsExpectedProblem = Exclude<
  ContactsProblem,
  { readonly _tag: 'ContactsInternalProblem' }
>;
export type ContactsForbiddenBody = Omit<
  Extract<ContactsProblem, { readonly _tag: 'ContactsForbiddenProblem' }>,
  '_tag'
>;
export type ContactsProblemTag = Pick<ContactsProblem, '_tag'>;

/** Conditional and `infer` positions are queries too. */
export type TagOf<Problem> = Problem extends { readonly _tag: infer Tag } ? Tag : never;
export type IsInternal<Problem> = Problem extends {
  readonly _tag: 'ContactsInternalProblem';
}
  ? true
  : false;

/** A mapped type over an existing union. */
export type ProblemByTag = {
  [Tag in ContactsProblem['_tag']]: Extract<ContactsProblem, { readonly _tag: Tag }>;
};
