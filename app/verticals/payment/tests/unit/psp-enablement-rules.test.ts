import { DateTime, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ConfigureGatewayEnablementPayloadSchema } from '../../shared/actions/configure-gateway-enablement.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../shared/domain/psp-configuration.ts';
import {
  configureGatewayEnablementAction,
  gatewayEnablementRefusal,
} from '../../src/actions/configure-gateway-enablement.action.ts';
import type { PaymentSourceAuthorityView } from '../../src/domain/source-qualification.ts';
import { verifiedGatewayBinding } from '../../src/integrations/psp/gateway-binding-live.ts';
import type { PaymentGatewayBindingVerification } from '../../src/ports/gateway-binding-port.ts';
import type {
  PspEnablementBinding,
  PspGatewayEnablementRecord,
} from '../../src/persistence/psp-enablement-persistence.ts';

/**
 * #1155/#1156 pure rules of Gateway Enablement: the fail-closed enabling prerequisites (D11, N9) and the
 * exact selected-binding verification of the live `GatewayBindingPort`.
 */

const accountRef = (hex: string) => Schema.decodeSync(GatewayProviderAccountRefSchema)(`pab_${hex.repeat(32)}`);
const bindingId = (digit: string) =>
  Schema.decodeSync(GatewayProviderAccountBindingIdSchema)(
    `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
  );

/** An absent optional field, spelled once so the fixtures stay explicit about what an authority omits. */
const absent = <Value>(): Value | undefined => Option.getOrUndefined(Option.none<Value>());

const GOPAY_SANDBOX: PspEnablementBinding = {
  bindingId: bindingId('1'),
  environment: 'SANDBOX',
  providerAccountRef: accountRef('a'),
  providerFamily: 'GOPAY',
  status: 'CURRENT',
};
const STRIPE_SANDBOX: PspEnablementBinding = {
  bindingId: bindingId('2'),
  environment: 'SANDBOX',
  providerAccountRef: accountRef('b'),
  providerFamily: 'STRIPE',
  status: 'CURRENT',
};

const authority = (
  factFamily: PaymentSourceAuthorityView['factFamily'],
  overrides: Partial<PaymentSourceAuthorityView> = {},
): PaymentSourceAuthorityView => ({
  accountRef: GOPAY_SANDBOX.providerAccountRef,
  boundToSubmitter: false,
  environment: 'SANDBOX',
  factFamily,
  method: absent(),
  refundRoute: factFamily === 'REFUND_EXECUTION',
  revision: 1,
  sourceAuthorityId: `${factFamily}-authority`,
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
  status: 'ACTIVE',
  submitterPrincipalIds: [],
  ...overrides,
});

const BOTH_AUTHORITIES = [authority('GATEWAY_OUTCOME'), authority('REFUND_EXECUTION')];

const refusalCode = (binding: PspEnablementBinding, authorities: readonly PaymentSourceAuthorityView[]) =>
  Option.map(gatewayEnablementRefusal(binding, authorities), (refusal) => refusal.code);

const record = (
  binding: PspEnablementBinding,
  overrides: Partial<Omit<PspGatewayEnablementRecord, 'binding'>> = {},
): PspGatewayEnablementRecord => ({
  binding,
  configuredAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
  customerConfigurationId: 'cc-1',
  enabled: true,
  provenance: { actionInvocationId: 'invocation', actorPrincipalId: 'principal', compositionRevision: 'c'.repeat(64) },
  reason: 'Enable the gateway',
  returnUrl: 'https://shop.example.test/return',
  revision: 1,
  ...overrides,
});

const isEnabled = (verification: PaymentGatewayBindingVerification) =>
  Match.value(verification).pipe(
    Match.tag('ENABLED', () => true),
    Match.tag('NOT_ENABLED', () => false),
    Match.exhaustive,
  );

const selected = (binding: PspEnablementBinding): PaymentGatewayAccountBinding => ({
  _tag: 'GATEWAY_ACCOUNT',
  environment: binding.environment,
  providerAccountRef: binding.providerAccountRef,
  providerFamily: binding.providerFamily,
});

describe('#1155 Gateway Enablement prerequisites', () => {
  it('#1155 Enabling a Current binding with ACTIVE outcome and refund-route authorities is allowed', () => {
    expect(refusalCode(GOPAY_SANDBOX, BOTH_AUTHORITIES)).toEqual(Option.none());
    // A method-scoped online gateway authority counts like a method-neutral one.
    expect(
      refusalCode(GOPAY_SANDBOX, [
        authority('GATEWAY_OUTCOME', { method: 'ONLINE_GATEWAY' }),
        authority('REFUND_EXECUTION', { method: 'ONLINE_GATEWAY' }),
      ]),
    ).toEqual(Option.none());
  });

  it('#1155 Enabling without source authorities is rejected with gateway_source_authority_missing', () => {
    const missing = Option.some('gateway_source_authority_missing');
    expect(refusalCode(GOPAY_SANDBOX, [])).toEqual(missing);
    expect(refusalCode(GOPAY_SANDBOX, [authority('GATEWAY_OUTCOME')])).toEqual(missing);
    expect(refusalCode(GOPAY_SANDBOX, [authority('REFUND_EXECUTION')])).toEqual(missing);
    expect(
      refusalCode(GOPAY_SANDBOX, [authority('GATEWAY_OUTCOME'), authority('REFUND_EXECUTION', { refundRoute: false })]),
    ).toEqual(missing);
    expect(
      refusalCode(GOPAY_SANDBOX, [authority('GATEWAY_OUTCOME', { status: 'REVOKED' }), authority('REFUND_EXECUTION')]),
    ).toEqual(missing);
    expect(
      refusalCode(GOPAY_SANDBOX, [authority('GATEWAY_OUTCOME'), authority('REFUND_EXECUTION', { status: 'REVOKED' })]),
    ).toEqual(missing);
    // An authority scoped to another method never qualifies gateway evidence.
    expect(
      refusalCode(GOPAY_SANDBOX, [
        authority('GATEWAY_OUTCOME', { method: 'BANK_TRANSFER_ADVANCE' }),
        authority('REFUND_EXECUTION'),
      ]),
    ).toEqual(missing);
  });

  it('#1155 Comgate enablement is rejected with gateway_payer_contact_source_missing', () => {
    const comgate: PspEnablementBinding = { ...GOPAY_SANDBOX, providerFamily: 'COMGATE' };
    expect(refusalCode(comgate, BOTH_AUTHORITIES)).toEqual(Option.some('gateway_payer_contact_source_missing'));
  });

  it('#1155 A binding retired for new intents cannot be enabled', () => {
    const retired: PspEnablementBinding = { ...GOPAY_SANDBOX, status: 'RETIRED_FOR_NEW_INTENTS' };
    expect(refusalCode(retired, BOTH_AUTHORITIES)).toEqual(Option.some('gateway_binding_not_current'));
  });

  it('#1155 The Action is critical, approval-capable and placed under payments/manage', () => {
    const { accessDeclaration } = configureGatewayEnablementAction.descriptor;
    expect(accessDeclaration).toMatchObject({
      key: 'payment.core.gateway-enablement.configure',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'payments', level: 'manage' },
      risk: 'critical',
    });
  });

  it('#1155 The payload never accepts plain http return URLs or non-pab account references', () => {
    const decode = Schema.decodeUnknownOption(ConfigureGatewayEnablementPayloadSchema);
    const valid = {
      customerConfigurationId: 'cc-1',
      enabled: true,
      environment: 'SANDBOX',
      providerAccountRef: `pab_${'a'.repeat(32)}`,
      reason: 'Enable the gateway',
      returnUrl: 'https://shop.example.test/return',
    };
    expect(Option.isSome(decode(valid))).toBe(true);
    expect(Option.isNone(decode({ ...valid, returnUrl: 'http://shop.example.test/return' }))).toBe(true);
    expect(Option.isNone(decode({ ...valid, providerAccountRef: 'gopay-account-1' }))).toBe(true);
    expect(Option.isNone(decode({ ...valid, environment: 'production' }))).toBe(true);
  });
});

describe('#1155/#1156 live GatewayBindingPort verification', () => {
  it('#1155 Disabled gateway is not offered to new intents', () => {
    expect(
      isEnabled(verifiedGatewayBinding(selected(GOPAY_SANDBOX), [record(GOPAY_SANDBOX, { enabled: false })])),
    ).toBe(false);
    expect(isEnabled(verifiedGatewayBinding(selected(GOPAY_SANDBOX), []))).toBe(false);
    const retired = { ...GOPAY_SANDBOX, status: 'RETIRED_FOR_NEW_INTENTS' as const };
    expect(isEnabled(verifiedGatewayBinding(selected(retired), [record(retired)]))).toBe(false);
    const enabled = verifiedGatewayBinding(selected(GOPAY_SANDBOX), [record(GOPAY_SANDBOX)]);
    expect(isEnabled(enabled)).toBe(true);
    expect(enabled.binding).toEqual(selected(GOPAY_SANDBOX));
  });

  it('#1155 One provider outage does not gate unrelated providers', () => {
    const records = [record(GOPAY_SANDBOX, { enabled: false }), record(STRIPE_SANDBOX)];
    expect(isEnabled(verifiedGatewayBinding(selected(STRIPE_SANDBOX), records))).toBe(true);
    expect(isEnabled(verifiedGatewayBinding(selected(GOPAY_SANDBOX), records))).toBe(false);
  });

  it('#1156 Selected binding must equal an enabled binding exactly', () => {
    const records = [record(GOPAY_SANDBOX)];
    const exact = selected(GOPAY_SANDBOX);
    expect(isEnabled(verifiedGatewayBinding(exact, records))).toBe(true);
    expect(isEnabled(verifiedGatewayBinding({ ...exact, environment: 'LIVE' }, records))).toBe(false);
    expect(isEnabled(verifiedGatewayBinding({ ...exact, providerAccountRef: accountRef('c') }, records))).toBe(false);
    expect(isEnabled(verifiedGatewayBinding({ ...exact, providerFamily: 'STRIPE' }, records))).toBe(false);
    // The verification names the selected binding; it never substitutes the enabled one.
    expect(verifiedGatewayBinding({ ...exact, environment: 'LIVE' }, records).binding.environment).toBe('LIVE');
  });
});
