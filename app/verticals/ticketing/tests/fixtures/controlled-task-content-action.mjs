import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { runAction } from '../../../../packages/core-runtime/src/core-sdk.ts';
import { sqlClient } from '../../../../packages/core-runtime/src/db/client.ts';
import { updateTaskContentActionRegistration } from '../../src/actions/update-task-content.ts';

const controlledHandler = async (...arguments_) => {
  process.send?.({ type: 'entered' });
  const [releaseMessage] = await once(process, 'message');
  if (releaseMessage?.type !== 'release') {
    throw new Error('Controlled Task content Action expected a release message.');
  }
  return updateTaskContentActionRegistration.handler(...arguments_);
};

const run = async ({ clock, operationContext, payload }) => {
  const result = await runAction({
    options: {
      authorizationChecker: () => ({ _tag: 'Allowed' }),
      clock: { now: () => new Date(clock) },
      operationContextResolver: () => ({ _tag: 'Success', operationContext }),
    },
    payload,
    registration: { ...updateTaskContentActionRegistration, handler: controlledHandler },
    transport: { headers: new Headers({ 'Idempotency-Key': randomUUID() }) },
  });
  process.send?.({ result, type: 'result' });
  await sqlClient.end({ timeout: 1 });
};

const [message] = await once(process, 'message');
try {
  if (message?.type !== 'run') {
    throw new Error('Controlled Task content Action expected a run message.');
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
