import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const dbTestsEnabled = process.env.OUTBOX_WORKER_DB_TESTS === '1';
const root = new URL('..', import.meta.url).pathname;
const coreRuntimeRequire = createRequire(
  new URL('../packages/core-runtime/package.json', import.meta.url),
);
const drizzleOrmModule = coreRuntimeRequire.resolve('drizzle-orm');
const proofTenantSlugPrefix = 'outbox-worker-proof-';

test(
  'outbox worker runtime proof',
  {
    skip: dbTestsEnabled
      ? false
      : 'Set OUTBOX_WORKER_DB_TESTS=1 or run pnpm test:outbox-worker to execute DB-backed worker proof tests.',
  },
  async (t) => {
    const [
      { db, sqlClient },
      { createVerticalGatewayToken, runAction },
      { sql },
      { materializeDeliveries },
      { claimDueDeliveries },
      { executeClaimedDelivery },
      { installedOutboxWorkerRegistrations },
      { createUnitActionRegistration },
    ] = await Promise.all([
      import('../packages/core-runtime/src/db/client.ts'),
      import('../packages/core-runtime/src/index.ts'),
      import(drizzleOrmModule),
      import('../packages/outbox-worker/src/materialize.ts'),
      import('../packages/outbox-worker/src/claim.ts'),
      import('../packages/outbox-worker/src/execute.ts'),
      import('../packages/outbox-worker/src/installed-workers.registry.ts'),
      import('../verticals/properties/src/actions/create-unit.registration.ts'),
    ]);

    const testOutboxWorkerTopic = 'proof.outbox.message';
    const testOutboxWorkerRegistration = {
      descriptor: {
        workerKey: 'proof.outbox.noop',
        owningModuleKey: 'outbox-worker-proof',
        executingModuleKey: 'outbox-worker-proof',
        topics: [testOutboxWorkerTopic],
        defaults: {
          maxAttempts: 2,
          retryBackoff: {
            kind: 'fixed',
            delayMs: 100,
          },
        },
      },
      handler: () => undefined,
    };

    const rowsFromResult = (result) => {
      if (Array.isArray(result)) {
        return result;
      }

      if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
        return Array.from(result);
      }

      return [];
    };

    const one = async (query) => {
      const row = rowsFromResult(await db.execute(query)).at(0);
      assert.ok(row, 'expected one row');
      return row;
    };

    const countRows = async (query) => {
      const row = await one(query);
      return row.count;
    };

    const deleteProofRows = async () => {
      const proofTenantPattern = `${proofTenantSlugPrefix}%`;

      await db.execute(sql`
        delete from properties.unit
        where name like 'Outbox Worker Proof Unit%'
      `);
      await db.execute(sql`
        delete from core.outbox_attempts attempt
        using core.outbox_deliveries delivery, core.outbox_messages message, core.tenants tenant
        where attempt.outbox_delivery_id = delivery.outbox_delivery_id
          and delivery.outbox_message_id = message.outbox_message_id
          and message.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.outbox_deliveries delivery
        using core.outbox_messages message, core.tenants tenant
        where delivery.outbox_message_id = message.outbox_message_id
          and message.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.outbox_messages message
        using core.tenants tenant
        where message.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.domain_events event
        using core.tenants tenant
        where event.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.audit_events audit
        using core.tenants tenant
        where audit.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.action_invocations action
        using core.tenants tenant
        where action.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.principal_auth_bindings binding
        using core.tenants tenant
        where binding.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.legal_entities legal_entity
        using core.tenants tenant
        where legal_entity.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.principals principal
        using core.tenants tenant
        where principal.tenant_id = tenant.tenant_id
          and tenant.slug like ${proofTenantPattern}
      `);
      await db.execute(sql`
        delete from core.tenants tenant
        where tenant.slug like ${proofTenantPattern}
      `);
    };

    const assertDatabaseReady = async () => {
      try {
        await db.execute(sql`select 1 from core.outbox_deliveries limit 0`);
      } catch (error) {
        throw new Error(
          'Outbox worker proof tests require a migrated mvp2 Postgres database at DATABASE_URL. Run docker compose up -d postgres postgres-init and pnpm --filter @mvp2/core-runtime db:migrate before pnpm test:outbox-worker.',
          { cause: error },
        );
      }
    };

    const createCoreFixture = async ({ payload = { proofId: randomUUID() }, topic }) => {
      const suffix = randomUUID();
      const tenant = await one(sql`
        insert into core.tenants (slug, name, status, default_locale)
        values (${`${proofTenantSlugPrefix}${suffix}`}, 'Outbox Worker Proof', 'active', 'en')
        returning tenant_id as "tenantId"
      `);
      const legalEntity = await one(sql`
        insert into core.legal_entities (
          tenant_id,
          legal_name,
          registration_country,
          registration_number,
          status
        )
        values (
          ${tenant.tenantId},
          'Outbox Worker Proof LLC',
          'CZ',
          ${`proof-${suffix}`},
          'active'
        )
        returning legal_entity_id as "legalEntityId"
      `);
      const principal = await one(sql`
        insert into core.principals (tenant_id, kind, display_name, status)
        values (${tenant.tenantId}, 'human', 'Proof Principal', 'active')
        returning principal_id as "principalId"
      `);
      const authBinding = await one(sql`
        insert into core.principal_auth_bindings (
          tenant_id,
          principal_id,
          provider,
          subject_type,
          provider_subject_id,
          status
        )
        values (
          ${tenant.tenantId},
          ${principal.principalId},
          'better_auth',
          'user',
          ${`proof-subject-${suffix}`},
          'active'
        )
        returning principal_auth_binding_id as "authBindingId"
      `);
      const action = await one(sql`
        insert into core.action_invocations (
          tenant_id,
          legal_entity_id,
          principal_id,
          auth_binding_id,
          auth_method,
          action_key,
          idempotency_key,
          target_module_key,
          status,
          request_hash
        )
        values (
          ${tenant.tenantId},
          ${legalEntity.legalEntityId},
          ${principal.principalId},
          ${authBinding.authBindingId},
          'session',
          'proof.source.action',
          ${`proof-idempotency-${suffix}`},
          'properties',
          'succeeded',
          ${`proof-request-${suffix}`}
        )
        returning
          action_invocation_id as "actionInvocationId",
          action_key as "actionKey",
          idempotency_key as "idempotencyKey"
      `);
      const domainEvent = await one(sql`
        insert into core.domain_events (
          tenant_id,
          legal_entity_id,
          action_invocation_id,
          producer_module_key,
          event_type,
          subject_module_key,
          subject_resource_type,
          subject_resource_id,
          payload_json,
          tenant_sequence_no
        )
        values (
          ${tenant.tenantId},
          ${legalEntity.legalEntityId},
          ${action.actionInvocationId},
          'properties',
          'proof.event.created',
          'properties',
          'proof_resource',
          ${`proof-resource-${suffix}`},
          ${JSON.stringify({ source: 'proof' })}::jsonb,
          1
        )
        returning domain_event_id as "domainEventId"
      `);
      const message = await one(sql`
        insert into core.outbox_messages (
          tenant_id,
          domain_event_id,
          producer_module_key,
          topic,
          payload_json
        )
        values (
          ${tenant.tenantId},
          ${domainEvent.domainEventId},
          'properties',
          ${topic},
          ${JSON.stringify(payload)}::jsonb
        )
        returning outbox_message_id as "outboxMessageId"
      `);

      return {
        action,
        authBinding,
        domainEvent,
        legalEntity,
        message,
        principal,
        tenant,
      };
    };

    const createDelivery = async ({
      attemptsCount = 0,
      executingModuleKey = testOutboxWorkerRegistration.descriptor.executingModuleKey,
      outboxMessageId,
      status = 'pending',
      workerKey = testOutboxWorkerRegistration.descriptor.workerKey,
    }) => {
      const delivery = await one(sql`
        insert into core.outbox_deliveries (
          outbox_message_id,
          worker_key,
          executing_module_key,
          status,
          attempts_count,
          available_at
        )
        values (
          ${outboxMessageId},
          ${workerKey},
          ${executingModuleKey},
          ${status},
          ${attemptsCount},
          now() - interval '1 second'
        )
        returning
          attempts_count as "attemptsCount",
          executing_module_key as "executingModuleKey",
          outbox_delivery_id as "outboxDeliveryId",
          outbox_message_id as "outboxMessageId",
          worker_key as "workerKey"
      `);

      if (status === 'processing') {
        await db.execute(sql`
          update core.outbox_deliveries
          set
            claimed_by = 'proof-runtime',
            claimed_at = now(),
            claim_expires_at = now() + interval '1 minute'
          where outbox_delivery_id = ${delivery.outboxDeliveryId}
        `);
      }

      return delivery;
    };

    const createAttempt = async (outboxDeliveryId) =>
      one(sql`
        insert into core.outbox_attempts (outbox_delivery_id)
        values (${outboxDeliveryId})
        returning outbox_attempt_id as "outboxAttemptId"
      `);

    const selectMessage = async (outboxMessageId) =>
      one(sql`
        select matched_at as "matchedAt"
        from core.outbox_messages
        where outbox_message_id = ${outboxMessageId}
      `);

    const selectDelivery = async (outboxDeliveryId) =>
      one(sql`
        select
          attempts_count as "attemptsCount",
          available_at as "availableAt",
          claimed_at as "claimedAt",
          claimed_by as "claimedBy",
          claim_expires_at as "claimExpiresAt",
          executing_module_key as "executingModuleKey",
          status,
          worker_key as "workerKey"
        from core.outbox_deliveries
        where outbox_delivery_id = ${outboxDeliveryId}
      `);

    const selectAttempt = async (outboxAttemptId) =>
      one(sql`
        select
          error_message as "errorMessage",
          finished_at as "finishedAt"
        from core.outbox_attempts
        where outbox_attempt_id = ${outboxAttemptId}
      `);

    const deliveryCountForMessage = async (outboxMessageId) =>
      countRows(sql`
        select count(*)::int as "count"
        from core.outbox_deliveries
        where outbox_message_id = ${outboxMessageId}
      `);

    const runtimeConfig = {
      claimBatchSize: 10,
      claimTimeoutMs: 60_000,
      materializeBatchSize: 10,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      retryBackoffMs: 50_000,
      runtimeId: 'proof-runtime',
    };

    const claimedDeliveryFrom = ({ attempt, delivery }) => ({
      attemptsCount: delivery.attemptsCount,
      executingModuleKey: delivery.executingModuleKey,
      outboxAttemptId: attempt.outboxAttemptId,
      outboxDeliveryId: delivery.outboxDeliveryId,
      outboxMessageId: delivery.outboxMessageId,
      workerKey: delivery.workerKey,
    });

    const claimInChildProcess = (runtimeId) =>
      new Promise((resolve, reject) => {
        const code = `
          import { claimDueDeliveries } from './packages/outbox-worker/src/claim.ts';
          import { sqlClient } from './packages/core-runtime/src/db/client.ts';

          try {
            const claimed = await claimDueDeliveries({
              batchSize: 1,
              claimTimeoutMs: 60000,
              runtimeId: ${JSON.stringify(runtimeId)}
            });
            process.stdout.write(JSON.stringify(claimed.map((delivery) => delivery.outboxDeliveryId)));
          } finally {
            await sqlClient.end({ timeout: 1 });
          }
        `;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
          cwd: root,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(stderr || `claim process exited with ${code}`));
            return;
          }

          resolve(JSON.parse(stdout || '[]'));
        });
      });

    t.after(async () => {
      await deleteProofRows();
      await sqlClient.end({ timeout: 5 });
    });

    await assertDatabaseReady();
    await deleteProofRows();

    await t.test('production registry does not install proof workers', () => {
      assert.equal(
        installedOutboxWorkerRegistrations.some(
          (registration) =>
            registration.descriptor.workerKey === testOutboxWorkerRegistration.descriptor.workerKey,
        ),
        false,
      );
      assert.deepEqual(testOutboxWorkerRegistration.descriptor.topics, [testOutboxWorkerTopic]);
    });

    await t.test('production registry installs the Accounting unit-created worker', () => {
      const accountingRegistration = installedOutboxWorkerRegistrations.find(
        (registration) => registration.descriptor.workerKey === 'accounting.propertiesUnitCreated',
      );

      assert.ok(accountingRegistration);
      assert.equal(accountingRegistration.descriptor.executingModuleKey, 'accounting');
      assert.deepEqual(accountingRegistration.descriptor.topics, ['properties.unit.created']);
    });

    await t.test(
      'createUnit action writes automatic domain event and typed outbox message',
      async () => {
        await deleteProofRows();
        const suffix = randomUUID();
        const tenant = await one(sql`
        insert into core.tenants (slug, name, status, default_locale)
        values (${`${proofTenantSlugPrefix}${suffix}`}, 'Outbox Worker Proof', 'active', 'en')
        returning tenant_id as "tenantId"
      `);
        const legalEntity = await one(sql`
        insert into core.legal_entities (
          tenant_id,
          legal_name,
          registration_country,
          registration_number,
          status
        )
        values (
          ${tenant.tenantId},
          'Outbox Worker Proof LLC',
          'CZ',
          ${`proof-action-${suffix}`},
          'active'
        )
        returning legal_entity_id as "legalEntityId"
      `);
        const principal = await one(sql`
        insert into core.principals (tenant_id, kind, display_name, status)
        values (${tenant.tenantId}, 'human', 'Proof Principal', 'active')
        returning principal_id as "principalId"
      `);
        const operationContextToken = createVerticalGatewayToken({
          audience: 'properties',
          operationContext: {
            legalEntityId: legalEntity.legalEntityId,
            principalId: principal.principalId,
            tenantId: tenant.tenantId,
          },
        });
        const unitName = `Outbox Worker Proof Unit ${suffix}`;
        const result = await runAction({
          payload: unitName,
          registration: createUnitActionRegistration,
          transport: {
            headers: new Headers({
              'idempotency-key': `proof-action-${suffix}`,
              'x-ontos-operation-context': operationContextToken,
            }),
          },
        });

        assert.equal(result._tag, 'OperationSucceeded');
        assert.equal(result.response.status, 'ok');
        assert.match(result.response.unitId, /^[0-9a-f-]{36}$/u);

        const event = await one(sql`
        select
          domain_event_id as "domainEventId",
          event_type as "eventType",
          payload_json as "payloadJson",
          producer_module_key as "producerModuleKey",
          subject_module_key as "subjectModuleKey",
          subject_resource_type as "subjectResourceType",
          subject_resource_id as "subjectResourceId",
          tenant_sequence_no as "tenantSequenceNo"
        from core.domain_events
        where action_invocation_id = ${result.context.actionInvocation.actionInvocationId}
      `);
        assert.equal(event.eventType, 'properties.unit.created');
        assert.equal(event.producerModuleKey, 'properties');
        assert.equal(event.subjectModuleKey, 'properties');
        assert.equal(event.subjectResourceType, 'property.unit');
        assert.equal(event.subjectResourceId, result.response.unitId);
        assert.equal(event.payloadJson.name, unitName);
        assert.equal(event.payloadJson.unitId, result.response.unitId);
        assert.equal(String(event.tenantSequenceNo), '1');

        const message = await one(sql`
        select
          outbox_message_id as "outboxMessageId",
          payload_json as "payloadJson",
          producer_module_key as "producerModuleKey",
          topic
        from core.outbox_messages
        where domain_event_id = ${event.domainEventId}
      `);
        assert.equal(message.topic, 'properties.unit.created');
        assert.equal(message.producerModuleKey, 'properties');
        assert.equal(message.payloadJson.name, unitName);
        assert.equal(message.payloadJson.unitId, result.response.unitId);

        const materialized = await materializeDeliveries({
          batchSize: 10,
          registrations: installedOutboxWorkerRegistrations,
        });
        assert.deepEqual(materialized, {
          deliveriesInserted: 1,
          messagesMatched: 1,
        });

        const delivery = await one(sql`
        select
          executing_module_key as "executingModuleKey",
          status,
          worker_key as "workerKey"
        from core.outbox_deliveries
        where outbox_message_id = ${message.outboxMessageId}
      `);
        assert.equal(delivery.executingModuleKey, 'accounting');
        assert.equal(delivery.status, 'pending');
        assert.equal(delivery.workerKey, 'accounting.propertiesUnitCreated');
      },
    );

    await t.test('zero-match messages still receive matchedAt', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: 'proof.unmatched.message' });

      const result = await materializeDeliveries({
        batchSize: 10,
        registrations: [testOutboxWorkerRegistration],
      });

      assert.deepEqual(result, {
        deliveriesInserted: 0,
        messagesMatched: 1,
      });
      assert.ok((await selectMessage(fixture.message.outboxMessageId)).matchedAt);
      assert.equal(await deliveryCountForMessage(fixture.message.outboxMessageId), 0);
    });

    await t.test('one matching registration creates one delivery', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: testOutboxWorkerTopic });

      const result = await materializeDeliveries({
        batchSize: 10,
        registrations: [testOutboxWorkerRegistration],
      });

      assert.deepEqual(result, {
        deliveriesInserted: 1,
        messagesMatched: 1,
      });
      assert.ok((await selectMessage(fixture.message.outboxMessageId)).matchedAt);
      assert.equal(await deliveryCountForMessage(fixture.message.outboxMessageId), 1);
    });

    await t.test('multiple matching registrations create independent deliveries', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: testOutboxWorkerTopic });
      const secondRegistration = {
        descriptor: {
          ...testOutboxWorkerRegistration.descriptor,
          workerKey: 'proof.outbox.second-noop',
          executingModuleKey: 'outbox-worker-proof-second',
        },
        handler: () => undefined,
      };

      const result = await materializeDeliveries({
        batchSize: 10,
        registrations: [testOutboxWorkerRegistration, secondRegistration],
      });

      assert.deepEqual(result, {
        deliveriesInserted: 2,
        messagesMatched: 1,
      });
      assert.equal(await deliveryCountForMessage(fixture.message.outboxMessageId), 2);
    });

    await t.test('materialization reruns are duplicate-safe', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: testOutboxWorkerTopic });
      await createDelivery({ outboxMessageId: fixture.message.outboxMessageId });

      const firstResult = await materializeDeliveries({
        batchSize: 10,
        registrations: [testOutboxWorkerRegistration],
      });
      const secondResult = await materializeDeliveries({
        batchSize: 10,
        registrations: [testOutboxWorkerRegistration],
      });

      assert.deepEqual(firstResult, {
        deliveriesInserted: 0,
        messagesMatched: 1,
      });
      assert.deepEqual(secondResult, {
        deliveriesInserted: 0,
        messagesMatched: 0,
      });
      assert.equal(await deliveryCountForMessage(fixture.message.outboxMessageId), 1);
    });

    await t.test('due pending deliveries are claimed once', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: testOutboxWorkerTopic });
      const delivery = await createDelivery({ outboxMessageId: fixture.message.outboxMessageId });

      const claimed = await claimDueDeliveries({
        batchSize: 10,
        claimTimeoutMs: 60_000,
        runtimeId: 'proof-claim-once',
      });

      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].outboxDeliveryId, delivery.outboxDeliveryId);

      const storedDelivery = await selectDelivery(delivery.outboxDeliveryId);
      assert.equal(storedDelivery.status, 'processing');
      assert.equal(storedDelivery.attemptsCount, 1);
      assert.equal(storedDelivery.claimedBy, 'proof-claim-once');
      assert.ok(storedDelivery.claimedAt);
      assert.ok(storedDelivery.claimExpiresAt);
      assert.equal(
        await countRows(sql`
          select count(*)::int as "count"
          from core.outbox_attempts
          where outbox_delivery_id = ${delivery.outboxDeliveryId}
        `),
        1,
      );
    });

    await t.test('concurrent claim attempts cannot claim the same delivery twice', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: testOutboxWorkerTopic });
      const delivery = await createDelivery({ outboxMessageId: fixture.message.outboxMessageId });

      const [firstClaim, secondClaim] = await Promise.all([
        claimInChildProcess('proof-concurrent-a'),
        claimInChildProcess('proof-concurrent-b'),
      ]);
      const claimedIds = [...firstClaim, ...secondClaim];

      assert.deepEqual(claimedIds, [delivery.outboxDeliveryId]);
      assert.equal(
        await countRows(sql`
          select count(*)::int as "count"
          from core.outbox_attempts
          where outbox_delivery_id = ${delivery.outboxDeliveryId}
        `),
        1,
      );
    });

    await t.test('handler input reconstructs original execution context fields', async () => {
      await deleteProofRows();
      const payload = { proofId: randomUUID() };
      const fixture = await createCoreFixture({ payload, topic: testOutboxWorkerTopic });
      const delivery = await createDelivery({
        attemptsCount: 1,
        outboxMessageId: fixture.message.outboxMessageId,
        status: 'processing',
      });
      const attempt = await createAttempt(delivery.outboxDeliveryId);
      const observedInputs = [];
      const registration = {
        ...testOutboxWorkerRegistration,
        handler: (input, services) => {
          observedInputs.push({ input, hasTransaction: services.tx !== undefined });
        },
      };

      await executeClaimedDelivery({
        claimedDelivery: claimedDeliveryFrom({ attempt, delivery }),
        registrations: [registration],
        runtimeConfig,
      });

      assert.equal(observedInputs.length, 1);
      assert.equal(observedInputs[0].hasTransaction, true);
      assert.deepEqual(observedInputs[0].input.payload, payload);
      assert.deepEqual(observedInputs[0].input.context, {
        tenantId: fixture.tenant.tenantId,
        legalEntityId: fixture.legalEntity.legalEntityId,
        originalPrincipalId: fixture.principal.principalId,
        originalAuthBindingId: fixture.authBinding.authBindingId,
        originalActionInvocationId: fixture.action.actionInvocationId,
        originalActionKey: fixture.action.actionKey,
        originalActionIdempotencyKey: fixture.action.idempotencyKey,
        producerModuleKey: 'properties',
        executingModuleKey: testOutboxWorkerRegistration.descriptor.executingModuleKey,
        workerKey: testOutboxWorkerRegistration.descriptor.workerKey,
        topic: testOutboxWorkerTopic,
        outboxMessageId: fixture.message.outboxMessageId,
        outboxDeliveryId: delivery.outboxDeliveryId,
        domainEventId: fixture.domainEvent.domainEventId,
        idempotencyKey: delivery.outboxDeliveryId,
      });
      assert.equal((await selectDelivery(delivery.outboxDeliveryId)).status, 'done');
      assert.ok((await selectAttempt(attempt.outboxAttemptId)).finishedAt);
    });

    await t.test('failed handlers return deliveries to pending with backoff', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: testOutboxWorkerTopic });
      const delivery = await createDelivery({
        attemptsCount: 1,
        outboxMessageId: fixture.message.outboxMessageId,
        status: 'processing',
      });
      const attempt = await createAttempt(delivery.outboxDeliveryId);
      const registration = {
        ...testOutboxWorkerRegistration,
        descriptor: {
          ...testOutboxWorkerRegistration.descriptor,
          defaults: {
            maxAttempts: 3,
            retryBackoff: {
              kind: 'fixed',
              delayMs: 50_000,
            },
          },
        },
        handler: () => {
          throw new Error('proof retry failure');
        },
      };
      const startedAt = new Date();

      await executeClaimedDelivery({
        claimedDelivery: claimedDeliveryFrom({ attempt, delivery }),
        registrations: [registration],
        runtimeConfig,
      });

      const storedDelivery = await selectDelivery(delivery.outboxDeliveryId);
      const storedAttempt = await selectAttempt(attempt.outboxAttemptId);
      assert.equal(storedDelivery.status, 'pending');
      assert.equal(storedDelivery.claimedBy, null);
      assert.equal(storedDelivery.claimedAt, null);
      assert.equal(storedDelivery.claimExpiresAt, null);
      assert.ok(new Date(storedDelivery.availableAt).getTime() > startedAt.getTime());
      assert.ok(storedAttempt.finishedAt);
      assert.match(storedAttempt.errorMessage, /proof retry failure/u);
    });

    await t.test('max-attempt failures mark deliveries dead', async () => {
      await deleteProofRows();
      const fixture = await createCoreFixture({ topic: testOutboxWorkerTopic });
      const delivery = await createDelivery({
        attemptsCount: 2,
        outboxMessageId: fixture.message.outboxMessageId,
        status: 'processing',
      });
      const attempt = await createAttempt(delivery.outboxDeliveryId);
      const registration = {
        ...testOutboxWorkerRegistration,
        descriptor: {
          ...testOutboxWorkerRegistration.descriptor,
          defaults: {
            maxAttempts: 2,
            retryBackoff: {
              kind: 'fixed',
              delayMs: 50_000,
            },
          },
        },
        handler: () => {
          throw new Error('proof dead failure');
        },
      };

      await executeClaimedDelivery({
        claimedDelivery: claimedDeliveryFrom({ attempt, delivery }),
        registrations: [registration],
        runtimeConfig,
      });

      const storedDelivery = await selectDelivery(delivery.outboxDeliveryId);
      const storedAttempt = await selectAttempt(attempt.outboxAttemptId);
      assert.equal(storedDelivery.status, 'dead');
      assert.equal(storedDelivery.claimedBy, null);
      assert.ok(storedAttempt.finishedAt);
      assert.match(storedAttempt.errorMessage, /proof dead failure/u);
    });
  },
);
