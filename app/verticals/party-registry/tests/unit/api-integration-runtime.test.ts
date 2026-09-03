// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import { Effect, Layer, Schema } from 'effect';

import { makePartyRegistryApiRuntime } from '../../api/index.ts';
import { partyRegistryReadinessSchema } from '../../shared/api.ts';
import { PartySearchProjectionGateway } from '../../shared/domain/search-projection-gateway.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { AresSubjectService } from '../../src/integrations/ares/ares-subject.service.ts';

test('serves readiness and rejects the removed placeholder write without business dependencies', async () => {
  let businessCalls = 0;
  const unexpectedBusinessCall = () => {
    businessCalls += 1;
    return Effect.die('Readiness must not execute a business operation');
  };
  const runtime = makePartyRegistryApiRuntime(
    Layer.succeed(ReadRuntime, { runRead: unexpectedBusinessCall }),
    Layer.succeed(AresSubjectService, { subject: unexpectedBusinessCall }),
    Layer.succeed(PartySearchProjectionGateway, {
      searchCounterparties: unexpectedBusinessCall,
      searchParties: unexpectedBusinessCall,
    }),
    Layer.succeed(ActionRuntime, {
      resolveActionCommit: unexpectedBusinessCall,
      runAction: unexpectedBusinessCall,
    }),
  );
  const server = runtime.createHandler();
  try {
    const response = await server.handler(new Request('http://localhost/party-registry/readiness'));
    assert.equal(response.status, 200);
    const readiness = Schema.decodeUnknownSync(partyRegistryReadinessSchema)(await response.json());
    assert.deepEqual(readiness.marker, ultramodernApiMarker);
    assert.equal(readiness.status, 'ready');

    const removedWrite = await server.handler(
      new Request('http://localhost/party-registry', {
        body: JSON.stringify({ name: 'Must not create an item' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    assert.equal(removedWrite.status, 404);
    assert.equal(businessCalls, 0);
  } finally {
    await server.dispose();
  }
});
