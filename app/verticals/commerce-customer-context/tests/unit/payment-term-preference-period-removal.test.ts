import { Predicate } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import type { CustomerPaymentTermEntitlementRef } from '../../shared/resources/customer-payment-term-entitlement.ts';
import type {
  CustomerPaymentTermsState,
  PaymentTermDefinitionSnapshot,
  PaymentTermReference,
} from '../../shared/domain/payment-term-contracts.ts';
import {
  changeCustomerPaymentTerms,
  projectCustomerPaymentTermsAt,
  removeCustomerPaymentTerm,
} from '../../shared/domain/payment-terms.ts';
import type { CustomerPaymentTermsChange } from '../../shared/domain/payment-terms.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const term = (digit = '3'): PaymentTermReference => ({
  moduleId: 'payment.term-catalog',
  resourceId: id(digit),
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});
const ref = (digit: string): CustomerPaymentTermEntitlementRef => ({
  moduleId: 'commerce.customer-context',
  resourceId: id(digit),
  resourceType: 'commerce.customer-context.customer-payment-term-entitlement',
  tenantId,
});
const at = (month: string) => `2027-${month}-01T00:00:00.000Z`;
const definition = (paymentTermRef: PaymentTermReference): PaymentTermDefinitionSnapshot => ({
  code: 'PERIOD_SCOPE',
  compatibilityId: 'immediate.v1',
  definitionRevisionId: id('9'),
  lifecycle: { effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
  metadataRevision: 1,
  name: 'Immediate',
  paymentTermRef,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: paymentTermRef.resourceId,
  semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
});
const empty = (): CustomerPaymentTermsState => ({
  entitlements: [],
  preferences: [],
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: id('2'),
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
  revision: 1,
});
const change = (
  state: CustomerPaymentTermsState,
  changes: readonly CustomerPaymentTermsChange[],
): CustomerPaymentTermsState => {
  const result = changeCustomerPaymentTerms({
    catalogDefinitions: [definition(term()), definition(term('4'))],
    changes,
    expectedRevision: state.revision,
    state,
  });
  assert(Predicate.isTagged(result, 'CHANGED'));
  return result.state;
};
const grant = (digit: string, from: string, to?: string, paymentTermRef = term()): CustomerPaymentTermsChange => {
  const base = {
    _tag: 'GRANT_ENTITLEMENT' as const,
    effectiveFrom: at(from),
    entitlementRef: ref(digit),
    paymentTermRef,
    semanticRevisionId: paymentTermRef.resourceId,
  };
  return to === undefined ? base : { ...base, effectiveTo: at(to) };
};
const prefer = (from: string, to?: string, paymentTermRef = term()): CustomerPaymentTermsChange => {
  const base = { _tag: 'SET_PREFERENCE' as const, effectiveFrom: at(from), paymentTermRef };
  return to === undefined ? base : { ...base, effectiveTo: at(to) };
};
const remove = (state: CustomerPaymentTermsState, digit: string, month: string) => {
  const result = removeCustomerPaymentTerm({
    effectiveAt: at(month),
    entitlementRef: ref(digit),
    expectedRevision: state.revision,
    state,
  });
  assert(Predicate.isTagged(result, 'REMOVED'));
  return result;
};

it('preserves the complete A-backed preference when cancelling open or finite future B', () => {
  for (const end of [undefined, '12']) {
    const state = change(empty(), [grant('5', '01', '06'), grant('6', '07', end), prefer('01', '06')]);
    const before = projectCustomerPaymentTermsAt(state, at('03'), true);
    const result = remove(state, '6', '03');
    expect(result).toMatchObject({ changed: true, preferenceCleared: false, removalKind: 'CANCELLED' });
    expect(result.state.preferences).toEqual(state.preferences);
    expect(result.state.preferences[0]).toBe(state.preferences[0]);
    expect(result.state.entitlements[0]).toBe(state.entitlements[0]);
    expect(result.state.entitlements[1]).toMatchObject({
      cancelledAt: at('03'),
      effectiveFrom: at('07'),
      originalEffectiveTo: end === undefined ? null : at(end),
      status: 'CANCELLED',
    });
    expect(projectCustomerPaymentTermsAt(result.state, at('03'), true).currentPreference).toEqual(
      before.currentPreference,
    );
    expect(projectCustomerPaymentTermsAt(result.state, at('06'), true).state.preferences).toEqual(state.preferences);
  }
});

it('preserves later C preference when removing exact future B of the same term', () => {
  const state = change(empty(), [
    grant('5', '01', '04'),
    grant('6', '05', '07'),
    grant('7', '08'),
    prefer('01', '04'),
    prefer('08'),
  ]);
  const result = remove(state, '6', '03');
  expect(result.preferenceCleared).toBe(false);
  expect(result.state.preferences).toEqual(state.preferences);
  expect(result.state.entitlements[2]).toBe(state.entitlements[2]);
});

it('ends only the preference that actually loses coverage and never chooses another term', () => {
  for (const end of [undefined, '06']) {
    const state = change(empty(), [grant('5', '01', end), grant('6', '01', undefined, term('4')), prefer('01', end)]);
    const result = remove(state, '5', '03');
    expect(result.preferenceCleared).toBe(true);
    expect(result.state.preferences).toEqual([{ ...state.preferences[0], effectiveTo: at('03') }]);
    expect(projectCustomerPaymentTermsAt(result.state, at('03'), false).currentPreference).toBeUndefined();
    expect(projectCustomerPaymentTermsAt(result.state, at('02'), true).currentPreference).toEqual(
      result.state.preferences[0],
    );
    expect(result.state.entitlements[1]).toBe(state.entitlements[1]);
  }
});

it('cancels only future preferences supported by the removed entitlement, including start equality', () => {
  for (const removalMonth of ['03', '07']) {
    const state = change(empty(), [
      grant('5', '01', '06'),
      grant('6', '07', '09'),
      prefer('01', '06'),
      prefer('07', '09'),
    ]);
    const result = remove(state, '6', removalMonth);
    expect(result.preferenceCleared).toBe(true);
    expect(result.state.preferences).toEqual([state.preferences[0]]);
    expect(projectCustomerPaymentTermsAt(result.state, at('08'), true).state.preferences).toEqual([
      state.preferences[0],
    ]);
  }
});

it('removes a preference beginning exactly at an interior entitlement end operation', () => {
  const state = change(empty(), [grant('5', '01', '09'), prefer('03', '06')]);
  const result = remove(state, '5', '03');
  expect(result.preferenceCleared).toBe(true);
  expect(result.state.preferences).toEqual([]);
});

it('leaves already ended preferences and natural entitlement end equality unchanged', () => {
  const state = change(empty(), [grant('5', '01', '06'), prefer('01', '03')]);
  const truncated = remove(state, '5', '03');
  expect(truncated.preferenceCleared).toBe(false);
  expect(truncated.state.preferences).toEqual(state.preferences);
  const expired = remove(state, '5', '06');
  expect(expired).toMatchObject({ changed: false, preferenceCleared: false });
  expect(expired.state).toBe(state);
});

it('does not touch a supported preference of a different term', () => {
  const state = change(empty(), [grant('5', '01', '06', term('4')), grant('6', '07'), prefer('01', '06', term('4'))]);
  expect(remove(state, '6', '03').state.preferences).toEqual(state.preferences);
});

it('shares exact-period behavior with Change END_ENTITLEMENT', () => {
  const state = change(empty(), [grant('5', '01', '06'), grant('6', '07'), prefer('01', '06')]);
  const ended = change(state, [{ _tag: 'END_ENTITLEMENT', effectiveAt: at('03'), entitlementRef: ref('6') }]);
  expect(ended.preferences).toEqual(state.preferences);
  expect(ended.entitlements).toEqual(remove(state, '6', '03').state.entitlements);
});

it('keeps explicit CLEAR and SET preference intent behavior unchanged', () => {
  const state = change(empty(), [grant('5', '01'), grant('6', '01', undefined, term('4')), prefer('01')]);
  const cleared = change(state, [{ _tag: 'CLEAR_PREFERENCE', effectiveAt: at('03') }]);
  expect(cleared.preferences).toEqual([{ ...state.preferences[0], effectiveTo: at('03') }]);
  const selected = change(state, [prefer('03', undefined, term('4'))]);
  expect(selected.preferences).toEqual([
    { ...state.preferences[0], effectiveTo: at('03') },
    { effectiveFrom: at('03'), paymentTermRef: term('4') },
  ]);
});

it('retains one-period coverage and rejects a preference spanning adjacent grants or a gap', () => {
  for (const start of ['06', '07']) {
    const state = change(empty(), [grant('5', '01', '06'), grant('6', start, '09')]);
    const result = changeCustomerPaymentTerms({
      catalogDefinitions: [definition(term())],
      changes: [prefer('01', '09')],
      expectedRevision: state.revision,
      state,
    });
    expect(Predicate.isTagged(result, 'PREFERENCE_CONFLICT')).toBe(true);
    expect(state.preferences).toEqual([]);
  }
});

it('retains stale CAS, overlapping grant, exact replay and conflicting removal guards', () => {
  const state = change(empty(), [grant('5', '01', '06'), grant('6', '07'), prefer('01', '06')]);
  const stale = removeCustomerPaymentTerm({
    effectiveAt: at('03'),
    entitlementRef: ref('6'),
    expectedRevision: state.revision - 1,
    state,
  });
  expect(Predicate.isTagged(stale, 'REVISION_CONFLICT')).toBe(true);
  const overlap = changeCustomerPaymentTerms({
    catalogDefinitions: [definition(term())],
    changes: [grant('7', '02', '04')],
    expectedRevision: state.revision,
    state,
  });
  expect(Predicate.isTagged(overlap, 'ENTITLEMENT_OVERLAP')).toBe(true);
  const removed = remove(state, '6', '03');
  const replay = remove(removed.state, '6', '03');
  expect(replay).toMatchObject({ changed: false, preferenceCleared: false });
  expect(replay.state).toBe(removed.state);
  const conflict = removeCustomerPaymentTerm({
    effectiveAt: at('04'),
    entitlementRef: ref('6'),
    expectedRevision: removed.state.revision,
    state: removed.state,
  });
  expect(Predicate.isTagged(conflict, 'REMOVAL_CONFLICT')).toBe(true);
  expect(state.preferences[0]?.effectiveTo).toBe(at('06'));
});

it('rejects a foreign Tenant entitlement identity without touching the profile state', () => {
  const state = change(empty(), [grant('5', '01', '06'), prefer('01', '06')]);
  const outcome = removeCustomerPaymentTerm({
    effectiveAt: at('03'),
    entitlementRef: { ...ref('5'), tenantId: id('9') },
    expectedRevision: state.revision,
    state,
  });
  expect(Predicate.isTagged(outcome, 'ENTITLEMENT_NOT_FOUND')).toBe(true);
  expect(state.preferences[0]?.effectiveTo).toBe(at('06'));
});
