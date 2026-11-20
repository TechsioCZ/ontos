import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { approvedMessageTypes } from '../../src/domain/catalog/approved-registry.ts';
import { approvedTypesDecisionLayer, CommunicationDecisionService } from '../../src/domain/catalog/decision-service.ts';
import {
  recoveryPolicyOf,
  resendPolicyOf,
  TransactionalMessageTypeSchema,
} from '../../src/domain/catalog/message-type.ts';
import {
  extendMessageTypeRegistry,
  findMessageTypeByPurpose,
  buildMessageTypeRegistry,
  MessageTypeRegistryInvalid,
} from '../../src/domain/catalog/registry.ts';
import {
  decideOrThrow,
  FIXTURE_ORIGINAL_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureSlot,
  fixtureType,
  fixtureTypeNamed,
  noMessageType,
  recipient,
  requiredTwoSlotType,
  requiredTwoSlotTypeWith,
} from './support/catalog-fixtures.ts';
import { candidatesOf, outcomeSummary } from './support/summaries.ts';

const violationTags = (types: Parameters<typeof buildMessageTypeRegistry>[0]) =>
  Result.match(buildMessageTypeRegistry(types), {
    onFailure: (error) => error.violations.map((violation) => violation._tag),
    onSuccess: () => [],
  });

const group = (slotKeys: readonly string[]) => ({
  approvalRuleKey: 'fixture.rule.indivisible',
  mode: 'INDIVISIBLE' as const,
  slotKeys,
});

const decodeType = Schema.decodeUnknownResult(TransactionalMessageTypeSchema, { onExcessProperty: 'error' });
const original = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original');

/** The evaluator built by the same approved-list builder the production layer uses. */
const evaluatorOver = (types: Parameters<typeof approvedTypesDecisionLayer>[0]) =>
  Effect.gen(function* evaluatorFromService() {
    return yield* CommunicationDecisionService;
  }).pipe(Effect.provide(approvedTypesDecisionLayer(types)));

const decideAll = (registry: Parameters<typeof decideOrThrow>[0], purposes: readonly string[]) =>
  purposes.map((purpose) => decideOrThrow(registry, fixtureRequest({ purpose }), fixtureContext([original])));

describe('#1394 Rule: the catalog approves types explicitly', () => {
  it('ships exactly the three Portal Auth types (#1406), and the approved list is a valid registry (module-load assertion for CI)', () => {
    expect(approvedMessageTypes.map(({ purpose }) => purpose)).toEqual([
      'commerce.customer-context.portal-auth.verify-email',
      'commerce.customer-context.portal-auth.reset-password',
      'commerce.customer-context.portal-auth.otp',
    ]);
    // Fails CI when a later owner activation adds an invalid type to the approved list.
    expect(Result.isSuccess(buildMessageTypeRegistry(approvedMessageTypes))).toBe(true);
  });

  it('AUTH-COM-01/13: every Portal Auth type is owned by Auth alone, required, recovery NONE, resend NOT_ALLOWED and without documents', () => {
    for (const type of approvedMessageTypes) {
      expect(type.sourceOwner).toBe('commerce.customer-context');
      expect(type.requiredness).toBe('REQUIRED');
      expect(recoveryPolicyOf(type)).toEqual({ kind: 'NONE' });
      expect(resendPolicyOf(type)).toBe('NOT_ALLOWED');
      expect(type.documents).toBeUndefined();
      expect(type.eligibleSourceStates).toEqual(['commerce.customer-context.portal-auth.issuance-current']);
      expect(
        type.result.kind === 'MESSAGE_INTENTS' && type.result.slots.map(({ source }) => source.evidenceKinds),
      ).toEqual([['HISTORICAL_SNAPSHOT']]);
    }
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

  it('rejects a source state that is both eligible and declared ineligible, or declared twice (#1406)', () => {
    const [open] = fixtureType().eligibleSourceStates;
    expect(
      violationTags([fixtureType({ ineligibleSourceStates: [{ reason: 'SOURCE_EXPIRED', state: open }] })]),
    ).toEqual(['IneligibleSourceStateConflict']);
    expect(
      violationTags([
        fixtureType({
          ineligibleSourceStates: [
            { reason: 'SOURCE_EXPIRED', state: 'fixture.state.gone' },
            { reason: 'SOURCE_REVOKED', state: 'fixture.state.gone' },
          ],
        }),
      ]),
    ).toEqual(['IneligibleSourceStateConflict']);
    // a state declared ineligible once, under its own reason, is a valid registry
    expect(
      violationTags([
        fixtureType({ ineligibleSourceStates: [{ reason: 'SOURCE_EXPIRED', state: 'fixture.state.gone' }] }),
      ]),
    ).toEqual([]);
  });

  it.effect('BR-05/AC-04: one invalid added type fails loudly at construction and never empties the registry', () =>
    Effect.gen(function* invalidAdditionIsLoud() {
      const valid = fixtureTypeNamed('good-addition');
      const invalid = fixtureTypeNamed('bad-addition', { privacyPurposeRefs: [] });
      const base = fixtureRegistry(fixtureType());
      const decideBase = () => decideOrThrow(base, fixtureRequest(), fixtureContext([original]));

      // The builder the production layer uses reports the invalid candidate explicitly instead of approving nothing.
      const failure = yield* Effect.flip(evaluatorOver([fixtureType(), valid, invalid]));
      expect(failure).toBeInstanceOf(MessageTypeRegistryInvalid);
      expect(failure.violations).toMatchObject([
        { _tag: 'ActiveTypeWithoutPrivacyPurpose', typeId: 'fixture.bad-addition-message' },
      ]);

      // Extending an existing registry fails the same way, and the registry it was extending stays fully usable.
      expect(Result.isFailure(extendMessageTypeRegistry(base, [valid, invalid]))).toBe(true);
      expect(candidatesOf(decideBase())).toHaveLength(1);

      // Without the invalid candidate the same builder yields a working evaluator over every valid type.
      const service = yield* evaluatorOver([fixtureType(), valid]);
      const decision = yield* service.decide(
        fixtureRequest({ purpose: 'fixture.good-addition' }),
        fixtureContext([original]),
      );
      expect(candidatesOf(decision)).toHaveLength(1);
    }),
  );

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

  it('#1395 Rule: an indivisible audience binds only slots the type has, once each, and only for messages', () => {
    expect(violationTags([requiredTwoSlotTypeWith({ audience: group(['primary', 'secondary']) })])).toEqual([]);
    expect(violationTags([requiredTwoSlotTypeWith({ audience: group(['primary', 'unknown-slot']) })])).toEqual([
      'IndivisibleGroupSlotInvalid',
    ]);
    expect(violationTags([requiredTwoSlotTypeWith({ audience: group(['primary', 'primary']) })])).toEqual([
      'IndivisibleGroupSlotInvalid',
    ]);
    expect(
      violationTags([
        fixtureTypeNamed('quiet-group', {
          audience: group(['primary']),
          result: { kind: 'NO_MESSAGE', ruleKey: 'fixture.rule.quiet' },
        }),
      ]),
    ).toEqual(['IndivisibleGroupWithoutMessages']);
  });

  it('keeps audience slot keys unique inside one type', () => {
    const duplicateSlots = {
      ...fixtureType(),
      result: {
        kind: 'MESSAGE_INTENTS',
        slots: [
          fixtureSlot('primary', 'original-recipient', 'EXACTLY_ONE'),
          fixtureSlot('primary', 'fixture-secondary', 'EXACTLY_ONE'),
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
