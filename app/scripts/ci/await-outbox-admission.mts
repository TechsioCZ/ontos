// Positive admission check for the outbox host after a stage publication. It replaces sleeping and grepping
// host logs: the host's internal /status must name the expected prebuilt artifact, list exactly the hosted
// owners, and show each owner ready with a successful cycle under the published composition revision.
//
//   await-outbox-admission.mts --revision <r> --host-digest <d> --timeout 180
//   await-outbox-admission.mts --host-digest <d> --probe
//
// The release reaches the host over the runner's Zerops VPN at http://$ZEROPS_OUTBOX_WORKER_HOST_HOSTNAME:4100.
// --probe answers once whether the live host already runs that artifact, so an unchanged host is not redeployed;
// it prints {"artifactDigest","matches","reachable"} and always exits 0. /status carries no configuration values.
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Duration, Effect, Layer, Option, Ref, Schema } from 'effect';
import type { FileSystem, Path } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/http';

import { OutboxWorkerHostStatusSchema } from '../../packages/core-runtime/src/outbox/health.ts';
import type { OutboxWorkerHostStatus } from '../../packages/core-runtime/src/outbox/health.ts';
import { OUTBOX_WORKER_HOST_HEALTH_PORT, readOutboxWorkerHost } from '../generate-outbox-worker-deployment.mjs';

export class OutboxAdmissionError extends Schema.TaggedError<OutboxAdmissionError>()('OutboxAdmissionError', {
  message: Schema.String,
}) {}

const ProbeResultSchema = Schema.Struct({
  artifactDigest: Schema.OptionFromNullOr(Schema.String),
  matches: Schema.Boolean,
  reachable: Schema.Boolean,
});
export type OutboxHostProbe = typeof ProbeResultSchema.Type;

const AdmittedSchema = Schema.Struct({
  admittedRevision: Schema.String,
  artifactDigest: Schema.OptionFromNullOr(Schema.String),
  owners: OutboxWorkerHostStatusSchema.fields.owners,
});

const POLL_INTERVAL = Duration.seconds(2);
const REQUEST_TIMEOUT = Duration.seconds(5);
const HostnameSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u));
const UNIDENTIFIED_OWNER = 'an unidentified owner';

/**
 * Every reason the host has not yet admitted the publication; empty means admitted. An owner admits a revision
 * only through a successful cycle under it, and stays ready only while its recent cycles keep succeeding.
 */
export const admissionShortfalls = (input: {
  readonly expectedOwners: readonly string[];
  readonly hostDigest: string;
  readonly revision: string;
  readonly status: OutboxWorkerHostStatus;
}): readonly string[] => {
  const { expectedOwners, hostDigest, revision, status } = input;
  const shortfalls: string[] = [];
  if (!Option.contains(status.artifactDigest, hostDigest)) {
    const running = Option.getOrElse(status.artifactDigest, () => 'none');
    shortfalls.push(`the host runs artifact ${running}, not ${hostDigest}`);
  }
  const reported = status.owners.map(({ appId }) => Option.getOrElse(appId, () => UNIDENTIFIED_OWNER));
  for (const owner of expectedOwners) {
    if (!reported.includes(owner)) {
      shortfalls.push(`${owner} is not hosted`);
    }
  }
  for (const [index, owner] of reported.entries()) {
    if (!expectedOwners.includes(owner) || reported.indexOf(owner) !== index) {
      shortfalls.push(`the host unexpectedly runs ${owner}`);
    }
  }
  for (const [index, owner] of status.owners.entries()) {
    const appId = reported[index] ?? UNIDENTIFIED_OWNER;
    if (!expectedOwners.includes(appId)) {
      continue;
    }
    if (!Option.contains(owner.admittedRevision, revision)) {
      shortfalls.push(`${appId} admitted ${Option.getOrElse(owner.admittedRevision, () => 'no revision')}`);
    } else if (!owner.ready || Option.isNone(owner.lastSuccessAt)) {
      shortfalls.push(`${appId} is not ready`);
    }
  }
  return shortfalls;
};

/** The owners the checked-out topology compiles into the host, in host order. */
export const expectedHostOwners: Effect.Effect<
  readonly string[],
  OutboxAdmissionError,
  FileSystem.FileSystem | Path.Path
> = readOutboxWorkerHost(path.resolve(import.meta.dirname, '../..')).pipe(
  Effect.mapError(() => new OutboxAdmissionError({ message: 'the hosted owners cannot be read from the topology' })),
  Effect.flatMap((host) =>
    host === undefined
      ? Effect.fail(new OutboxAdmissionError({ message: 'the topology hosts no Outbox Worker owners' }))
      : Effect.succeed([host.coreOwner.ownerId, ...host.owners.map(({ ownerId }) => ownerId)]),
  ),
);

/** One bounded read; an unreachable or malformed host is `None`, never a failure, so polling continues. */
const readStatus = (url: string) =>
  Effect.gen(function* readHostStatus() {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.get(url);
    return yield* HttpClientResponse.schemaBodyJson(OutboxWorkerHostStatusSchema)(response);
  }).pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.option);

export const probeOutboxHost = (input: { readonly hostDigest: string; readonly url: string }) =>
  readStatus(input.url).pipe(
    Effect.map((status): OutboxHostProbe => ({
      artifactDigest: status.pipe(Option.flatMap(({ artifactDigest }) => artifactDigest)),
      matches: status.pipe(Option.exists(({ artifactDigest }) => Option.contains(artifactDigest, input.hostDigest))),
      reachable: Option.isSome(status),
    })),
  );

/** Polls until every expected owner admitted the revision under the expected artifact, or the timeout passes. */
export const awaitOutboxAdmission = (input: {
  readonly expectedOwners: readonly string[];
  readonly hostDigest: string;
  readonly revision: string;
  readonly timeout: Duration.Duration;
  readonly url: string;
}) =>
  Effect.gen(function* awaitHostAdmission() {
    const reported = yield* Ref.make('');
    const poll: Effect.Effect<OutboxWorkerHostStatus, never, HttpClient.HttpClient> = Effect.gen(
      function* pollHostStatus() {
        const status = yield* readStatus(input.url);
        const shortfalls = Option.match(status, {
          onNone: () => ['the host status is unreachable'],
          onSome: (current) => admissionShortfalls({ ...input, status: current }),
        });
        if (Option.isSome(status) && shortfalls.length === 0) {
          return status.value;
        }
        // Log only changes, so a slow restart prints a handful of lines instead of one per poll.
        const summary = shortfalls.join('; ');
        if (summary !== (yield* Ref.getAndSet(reported, summary))) {
          yield* Console.log(`Waiting for outbox host admission: ${summary}`);
        }
        return yield* Effect.sleep(POLL_INTERVAL).pipe(Effect.andThen(Effect.suspend(() => poll)));
      },
    );
    return yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: input.timeout,
        orElse: () =>
          Ref.get(reported).pipe(
            Effect.flatMap((summary) =>
              Effect.fail(
                new OutboxAdmissionError({
                  message: `the outbox host did not admit revision ${input.revision} within ${Duration.format(input.timeout)}: ${summary}`,
                }),
              ),
            ),
          ),
      }),
    );
  });

const statusUrl = (configured: Option.Option<string>) =>
  Option.match(configured, {
    onNone: () =>
      Config.schema(HostnameSchema, 'ZEROPS_OUTBOX_WORKER_HOST_HOSTNAME').pipe(
        Effect.map((hostname) => `http://${hostname}:${OUTBOX_WORKER_HOST_HEALTH_PORT}/status`),
        Effect.mapError(
          () =>
            new OutboxAdmissionError({
              message: 'set ZEROPS_OUTBOX_WORKER_HOST_HOSTNAME (or --status-url) to reach the host status',
            }),
        ),
      ),
    onSome: Effect.succeed,
  });

const command = Command.make(
  'await-outbox-admission',
  {
    hostDigest: Flag.String('host-digest').pipe(Flag.withDescription('The plan host digest the host must run')),
    probe: Flag.Boolean('probe').pipe(
      Flag.withDefault(false),
      Flag.withDescription('Report once whether the live host runs that artifact'),
    ),
    revision: Flag.String('revision').pipe(
      Flag.optional,
      Flag.withDescription('The published composition revision every owner must admit'),
    ),
    statusUrl: Flag.String('status-url').pipe(
      Flag.optional,
      Flag.withDescription('Host /status URL; defaults to the VPN hostname in ZEROPS_OUTBOX_WORKER_HOST_HOSTNAME'),
    ),
    timeout: Flag.Int('timeout').pipe(Flag.withDefault(180), Flag.withDescription('Seconds to wait for admission')),
  },
  (flags) =>
    Effect.gen(function* runAdmissionCheck() {
      const url = yield* statusUrl(flags.statusUrl);
      if (flags.probe) {
        const probe = yield* probeOutboxHost({ hostDigest: flags.hostDigest, url });
        return yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(ProbeResultSchema))(probe));
      }
      if (Option.isNone(flags.revision) || flags.timeout < 1) {
        return yield* new OutboxAdmissionError({ message: '--revision and a positive --timeout are required' });
      }
      const admitted = yield* awaitOutboxAdmission({
        expectedOwners: yield* expectedHostOwners,
        hostDigest: flags.hostDigest,
        revision: flags.revision.value,
        timeout: Duration.seconds(flags.timeout),
        url,
      });
      return yield* Console.log(
        yield* Schema.encodeEffect(Schema.fromJsonString(AdmittedSchema))({
          admittedRevision: flags.revision.value,
          artifactDigest: admitted.artifactDigest,
          owners: admitted.owners,
        }),
      );
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
        Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
