import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { allowPolicy, runAction } from '../../../../packages/core-runtime/src/index.ts';
import { sqlClient } from '../../../../packages/core-runtime/src/db/client.ts';
import { createCheckboxPropertyDefinitionActionRegistration } from '../../src/actions/create-checkbox-property-definition.ts';
import { createTaskActionRegistration } from '../../src/actions/create-task.ts';

const concurrencyGate = async () => {
  process.send?.({ type: 'ready' });
  const [releaseMessage] = await once(process, 'message');
  if (releaseMessage?.type !== 'release') {
    throw new Error('Concurrent Action child expected a release message.');
  }
  return allowPolicy({
    policyKey: 'ticketing.test.concurrent-property-initialization',
    reason: 'Release both public Actions at the same transaction boundary.',
  });
};

const run = async ({ kind, operationContext, payload }) => {
  const registration =
    kind === 'task'
      ? createTaskActionRegistration
      : createCheckboxPropertyDefinitionActionRegistration;
  const result = await runAction({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      operationContextResolver: () => ({
        _tag: 'Success',
        operationContext,
      }),
    },
    payload,
    registration: { ...registration, policyChecks: [concurrencyGate] },
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  process.send?.({ result, type: 'result' });
  await sqlClient.end({ timeout: 1 });
};

const [message] = await once(process, 'message');
try {
  if (message?.type !== 'run') {
    throw new Error('Concurrent Action child expected a run message.');
  }
  await run(message);
} catch (error) {
  process.send?.({
    error: error instanceof Error ? error.stack : String(error),
    type: 'error',
  });
  await sqlClient.end({ timeout: 1 });
} finally {
  process.disconnect();
}
