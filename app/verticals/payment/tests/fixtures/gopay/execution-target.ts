/**
 * A GoPay SANDBOX execution target for unit tests. Every value is synthetic; the GoID is only the `{goid}` path
 * segment of `POST /eshops/{goid}/payments` (https://api-docs.gopay.com/spec/en/payments.yaml).
 */
import { Option, Schema } from 'effect';

import { GatewayExecutionTargetSchema } from '../../../src/integrations/psp/psp-request.ts';
import type { GatewayExecutionTarget } from '../../../src/integrations/psp/psp-request.ts';
import { GOPAY_FIXTURE_GOID } from './payment-responses.ts';

export const GOPAY_FIXTURE_ACCOUNT_REF = `pab_${'a1'.repeat(16)}`;

export const gopayExecutionTarget = (goid: string = GOPAY_FIXTURE_GOID): GatewayExecutionTarget =>
  Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
    binding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'SANDBOX',
      providerAccountRef: GOPAY_FIXTURE_ACCOUNT_REF,
      providerFamily: 'GOPAY',
    },
    bindingId: '7d3e9a10-55b2-4f6c-8a1d-2b3c4d5e6f70',
    credentialRevision: 1,
    credentialSecretRef: 'gopay.sandbox.fixture',
    legalEntityId: '2b6f0c1e-4d3a-4e5b-9c7d-8e9f0a1b2c3d',
    merchantIdentity: { _tag: 'GOPAY', goid },
    notificationUrl: 'https://payments.example.test/gopay/notify',
    returnUrl: Option.some('https://shop.example.test/return'),
    tenantId: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
  });
