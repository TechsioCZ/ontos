import { Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { approvedMessageTypeRegistry, approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import { decideCommunication } from '../../src/domain/catalog/decision.ts';
import { TransactionalMessageTypeSchema } from '../../src/domain/catalog/message-type.ts';
import {
  emptyMessageTypeRegistry,
  extendMessageTypeRegistry,
  findMessageTypeByPurpose,
  buildMessageTypeRegistry,
} from '../../src/domain/catalog/registry.ts';
import {
  FIXTURE_ORIGINAL_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureType,
  fixtureTypeNamed,
  noMessageType,
  recipient,
  requiredTwoSlotType,
} from './support/catalog-fixtures.ts';
import { candidatesOf, outcomeSummary } from './support/summaries.ts';

const violationTags = (types: Parameters<typeof buildMessageTypeRegistry>[0]) =>
  Result.match(buildMessageTypeRegistry(types), {
    onFailure: (error) => error.violations.map((violation) => violation._tag),
    onSuccess: () => [],
  });

const decodeType = Schema.decodeUnknownResult(TransactionalMessageTypeSchema, { onExcessProperty: 'error' });
const original = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original');

const decideAll = (registry: Parameters<typeof decideCommunication>[0], purposes: readonly string[]) =>
  purposes.map((purpose) => decideCommunication(registry, fixtureRequest({ purpose }), fixtureContext([original])));

describe('#1394 Rule: the catalog approves types explicitly', () => {
  it('ships no production type: the approved registry is empty until an owner activation approves one', () => {
    expect(approvedMessageTypes).toEqual([]);
    expect(approvedMessageTypeRegistry).toEqual(emptyMessageTypeRegistry);
    expect(Result.isSuccess(buildMessageTypeRegistry(approvedMessageTypes))).toBe(true);
  });

  it('BR-01: a registry never offers a type for a purpose it does not approve', () => {
    const registry = fixtureRegistry(fixtureType());

    expect(Option.isSome(findMessageTypeByPurpose(registry, fixtureRequest().purpose))).toBe(true);
    expect(
      Option.isNone(findMessageTypeByPurpose(registry, fixtureRequest({ purpose: 'fixture.unknown' }).purpose)),
    ).toBe(true);
  });

  it('rejects a list that breaks a registry invariant and registers nothing', () => {
    expect(violationTags([fixtureType(), fixtureType({ purpose: 'fixture.another' })])).toEqual(['DuplicateTypeId']);
    expect(violationTags([fixtureType(), fixtureType({ typeId: 'fixture.another-message' })])).toEqual([
      'DuplicatePurpose',
    ]);
    expect(violationTags([fixtureType({ privacyPurposeRefs: [] })])).toEqual(['ActiveTypeWithoutPrivacyPurpose']);
    expect(
      violationTags([fixtureTypeNamed('required-quiet', { requiredness: 'REQUIRED', result: noMessageType.result })]),
    ).toEqual(['RequiredTypeWithoutMessages']);
  });

  it('allows an inactive type without a Privacy purpose, since it can never be sent', () => {
    expect(violationTags([fixtureType({ privacyPurposeRefs: [], status: 'DEACTIVATED' })])).toEqual([]);
  });

  it('BR-11: type data has no place for message copy, language, address or secret material', () => {
    const fields = Object.keys(TransactionalMessageTypeSchema.fields);

    for (const forbidden of ['template', 'language', 'locale', 'address', 'email', 'token', 'otp', 'secret', 'proof']) {
      expect(fields.filter((field) => field.toLowerCase().includes(forbidden))).toEqual([]);
    }
    const withSecret = { ...fixtureType(), otpValue: '123456' };
    expect(Result.isFailure(decodeType(withSecret))).toBe(true);
  });

  it('keeps audience slot keys unique inside one type', () => {
    const duplicateSlots = {
      ...fixtureType(),
      result: {
        kind: 'MESSAGE_INTENTS',
        slots: [
          { cardinality: 'EXACTLY_ONE', recipientRole: 'original-recipient', slotKey: 'primary' },
          { cardinality: 'EXACTLY_ONE', recipientRole: 'fixture-secondary', slotKey: 'primary' },
        ],
      },
    };

    expect(Result.isFailure(decodeType(duplicateSlots))).toBe(true);
  });
});

describe('#1394 Rule: the catalog extends without a fixed quota or side effects', () => {
  it('AC-04: adding a type changes no other type and no other type decision', () => {
    const before = fixtureRegistry(fixtureType(), requiredTwoSlotType, noMessageType);
    const extended = extendMessageTypeRegistry(before, [fixtureTypeNamed('late-addition')]);
    const after = Result.getOrThrow(extended);
    const purposes = ['fixture.single', 'fixture.paired', 'fixture.quiet'];

    // Every existing entry is carried over unchanged, by reference, and every existing decision is identical.
    expect(after.types.slice(0, before.types.length).every((type, index) => type === before.types[index])).toBe(true);
    expect(decideAll(after, purposes)).toEqual(decideAll(before, purposes));
    expect(before.types).toHaveLength(3);
  });

  it('has no numeric cap on the number of approved types', () => {
    const many = Array.from({ length: 500 }, (_unused, index) => fixtureTypeNamed(`bulk-${index}`));
    const registry = fixtureRegistry(...many);

    expect(registry.types).toHaveLength(500);
    expect(
      decideAll(registry, ['fixture.bulk-0', 'fixture.bulk-499'])
        .map(candidatesOf)
        .map((found) => found.length),
    ).toEqual([1, 1]);
  });

  it('AC-08: onboarding a type activates no producer, so a declared but not activated type never sends', () => {
    const extended = Result.getOrThrow(
      extendMessageTypeRegistry(fixtureRegistry(fixtureType()), [
        fixtureTypeNamed('declared-only', { onboarding: 'NOT_ACTIVATED' }),
      ]),
    );
    const [declaredOnly] = decideAll(extended, ['fixture.declared-only']).map(outcomeSummary);

    expect(declaredOnly).toMatchObject({ kind: 'NoMessage', reason: 'SOURCE_ONBOARDING_INACTIVE' });
  });

  it('refuses an addition that conflicts with an approved type and keeps the registry unchanged', () => {
    const base = fixtureRegistry(fixtureType());
    const conflict = extendMessageTypeRegistry(base, [fixtureType({ typeId: 'fixture.rival-message' })]);

    expect(Result.isFailure(conflict)).toBe(true);
    expect(base.types).toHaveLength(1);
  });
});
