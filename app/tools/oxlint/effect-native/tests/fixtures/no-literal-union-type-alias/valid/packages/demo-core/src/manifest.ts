import { Schema } from 'effect';
import * as S from 'effect/Schema';

// The target shape: the vocabulary is owned by a codec, the type is derived from it.
export const OntosModuleKind = Schema.Literals(['application', 'library', 'vertical']);
export type OntosModuleKind = typeof OntosModuleKind.Type;

export const ActivationState = S.Literals(['active', 'inactive', 'pending']);
export type ActivationState = typeof ActivationState.Type;

// Derived from a runtime array — no second authority.
export const LOCALES = ['cs', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export type LocaleKey = keyof typeof LOCALES;

// Single member: a name, not a vocabulary (minMembers default 2).
export type ContactKind = 'customer';

// Not a closed vocabulary: the autocomplete idiom and mixed primitive unions.
export type LooseKind = 'customer' | 'supplier' | (string & {});
export type Mixed = 'a' | number;
export type MaybeCount = 'unlimited' | 42;
export type Flagged = 'on' | true;

// Interpolated template types are open.
export type Route = `/${string}` | `#${string}`;

// Generic aliases have no fixed member list.
export type Keys<T> = 'created' | 'updated' | Extract<keyof T, string>;

// Unions of references, not literals — tagged errors and models stay as they are.
export type ActionCoreError = ActionPolicyError | ActionCollectorError;
export type Payload = Readonly<{ a: string }> | Readonly<{ b: string }>;

// Object/union members inside an interface are not aliases.
export interface Descriptor {
  readonly auditProfile: 'minimal' | 'sensitive' | 'standard';
}

declare class ActionPolicyError {}
declare class ActionCollectorError {}
