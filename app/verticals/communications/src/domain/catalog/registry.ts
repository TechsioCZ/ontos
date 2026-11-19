import { Array as EffectArray, Data, Option, Result } from 'effect';

import type { TransactionalMessageType } from './message-type.ts';
import type { CommunicationPurposeKey } from './vocabulary.ts';

/** One reason an approved-type list cannot become a registry. */
export type MessageTypeRegistryViolationCase = Data.TaggedEnum<{
  /** An ACTIVE type needs at least one Privacy purpose reference; Privacy stays mandatory. */
  ActiveTypeWithoutPrivacyPurpose: { readonly typeId: string };
  /** Two types claim the same purpose, so the approved rule for it would be ambiguous. */
  DuplicatePurpose: { readonly purpose: string };
  DuplicateTypeId: { readonly typeId: string };
  /** A business-required type must produce messages; a required no-message rule would never be a failure. */
  RequiredTypeWithoutMessages: { readonly typeId: string };
}>;
export const MessageTypeRegistryViolation = Data.taggedEnum<MessageTypeRegistryViolationCase>();

/** Expected failure: the approved type list breaks a registry invariant. Nothing is registered. */
export class MessageTypeRegistryInvalid extends Data.TaggedError('MessageTypeRegistryInvalid')<{
  readonly violations: readonly MessageTypeRegistryViolationCase[];
}> {}

/** Immutable, explicit set of approved types. There is no discovery, no default type and no numeric cap. */
export interface MessageTypeRegistry {
  readonly byPurpose: ReadonlyMap<CommunicationPurposeKey, TransactionalMessageType>;
  readonly types: readonly TransactionalMessageType[];
}

/** The registry that approves nothing. Every purpose is unknown to it, so nothing is sendable. */
export const emptyMessageTypeRegistry: MessageTypeRegistry = { byPurpose: new Map(), types: [] };

const duplicates = <A>(values: readonly A[]) =>
  EffectArray.filter(EffectArray.dedupe(values), (value) => values.filter((other) => other === value).length > 1);

const violationsOf = (types: readonly TransactionalMessageType[]): readonly MessageTypeRegistryViolationCase[] => [
  ...duplicates(types.map((type) => type.typeId)).map((typeId) =>
    MessageTypeRegistryViolation.DuplicateTypeId({ typeId }),
  ),
  ...duplicates(types.map((type) => type.purpose)).map((purpose) =>
    MessageTypeRegistryViolation.DuplicatePurpose({ purpose }),
  ),
  ...types.flatMap(({ privacyPurposeRefs, status, typeId }) =>
    status === 'ACTIVE' && privacyPurposeRefs.length === 0
      ? [MessageTypeRegistryViolation.ActiveTypeWithoutPrivacyPurpose({ typeId })]
      : [],
  ),
  ...types.flatMap(({ requiredness, result, typeId }) =>
    requiredness === 'REQUIRED' && result.kind === 'NO_MESSAGE'
      ? [MessageTypeRegistryViolation.RequiredTypeWithoutMessages({ typeId })]
      : [],
  ),
];

/** Build a registry from explicitly approved types, or fail with every violated invariant. */
export const buildMessageTypeRegistry = (
  types: readonly TransactionalMessageType[],
): Result.Result<MessageTypeRegistry, MessageTypeRegistryInvalid> => {
  const violations = violationsOf(types);
  return violations.length > 0
    ? Result.fail(new MessageTypeRegistryInvalid({ violations }))
    : Result.succeed({ byPurpose: new Map(types.map((type) => [type.purpose, type])), types });
};

/**
 * The only way to add types: a new registry that keeps every existing entry unchanged. Adding a type cannot alter
 * another type's decision, and it activates no producer: sending still needs the source onboarding contract.
 */
export const extendMessageTypeRegistry = (registry: MessageTypeRegistry, added: readonly TransactionalMessageType[]) =>
  buildMessageTypeRegistry([...registry.types, ...added]);

export const findMessageTypeByPurpose = (registry: MessageTypeRegistry, purpose: CommunicationPurposeKey) =>
  Option.fromNullishOr(registry.byPurpose.get(purpose));
