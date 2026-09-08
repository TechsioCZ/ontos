import { Schema } from 'effect';

const ProblemSchema = Schema.Union([
  Schema.TaggedStruct('Internal', { status: Schema.Literal(500) }),
  Schema.TaggedStruct('Forbidden', { status: Schema.Literal(403) }),
]);
export type Problem = Schema.Schema.Type<typeof ProblemSchema>;

export type Internal = Extract<Problem, { readonly _tag: 'Internal' }>;
export type NotInternal = Exclude<Problem, { readonly _tag: 'Internal' }>;
export type Body = Omit<Extract<Problem, { readonly _tag: 'Forbidden' }>, '_tag'>;
export type Codec = Schema.Codec<{ readonly _tag: 'Internal' }>;
export type Wrapped = Readonly<Extract<Problem, { readonly _tag: 'Internal' }>>;
export type Keys = keyof { readonly _tag: 'Internal' };
export type Cond<T> = T extends { readonly _tag: 'Internal' } ? true : false;
export type TagOf<T> = T extends { readonly _tag: infer Tag } ? Tag : never;
export type ByTag = { [Tag in Problem['_tag']]: Extract<Problem, { readonly _tag: Tag }> };
