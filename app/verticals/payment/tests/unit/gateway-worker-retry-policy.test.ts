import { describe, expect, it } from 'effect-rstest';

import { executeGatewayOperationWorker } from '../../src/workers/execute-gateway-operation.worker.ts';
import { processProviderNotificationWorker } from '../../src/workers/process-provider-notification.worker.ts';
import { recoverGatewayOperationWorker } from '../../src/workers/recover-gateway-operation.worker.ts';

const PROVIDER_OUTAGE_RETRY_POLICY = {
  initialBackoffMs: 1000,
  maxAttempts: 60,
  maxBackoffMs: 1_800_000,
  multiplier: 2,
};

describe('#1158 Gateway worker retry schedules', () => {
  it('#1158 A transient provider outage cannot dead-letter a gateway delivery', () => {
    for (const worker of [
      executeGatewayOperationWorker,
      processProviderNotificationWorker,
      recoverGatewayOperationWorker,
    ]) {
      expect(worker.descriptor.retryPolicy).toEqual(PROVIDER_OUTAGE_RETRY_POLICY);
    }
  });

  it('#1158 The executor may defer across the whole Stripe replay window', () => {
    expect(executeGatewayOperationWorker.descriptor.maxDeferralMs).toBe(86_460_000);
  });
});
