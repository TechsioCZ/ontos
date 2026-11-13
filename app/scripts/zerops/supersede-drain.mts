/**
 * The hand-over of a superseded app host. When a newer release publishes the authority, the Zerops balancer still
 * sends this container public traffic until the new container passed its readiness probe (every 10 s) and the
 * balancer was reconfigured (measured: about 18 s). Closing the public port at once turned that window into 502s.
 *
 * Instead the old host keeps its public port open for `SUPERSEDED_DRAIN` and relays every request to the app
 * container(s) of the same service that hold the new release, found through the platform's internal DNS name of
 * the app service with this container's own addresses excluded, on the fixed public port. The relay never serves
 * the old release: Core refuses an old release's governed reads and writes once the new one published, and the old
 * owners are bypassed entirely. When no other container resolves, the port closes at once, as before.
 *
 * Internal callers (`http://app:3000`) reach either container during the drain, and both answer with the new
 * release: the new one directly, the old one by relaying to it.
 *
 * The readiness answer stays 200: `deploy.readinessCheck` decides when a NEW container takes traffic during a deploy
 * (`failureTimeout` bounds that wait and fails the deploy), not when an old one leaves, so a 503 from the old host
 * could not move the balancer sooner and could only be read as a failing container.
 */
import { promises as dns } from 'node:dns';
import { networkInterfaces } from 'node:os';

import { Console, Deferred, Duration, Effect, Option, Ref } from 'effect';

/**
 * How long a superseded host relays: the readiness probe period (`zerops.yaml` app `retryPeriod: 10s`) plus the
 * balancer's reconfiguration (measured: about 8 s), 2.5 times over. A stop signal ends it earlier: the platform stops
 * the old container only once traffic moved to the new one.
 */
export const SUPERSEDED_DRAIN = Duration.seconds(45);

/** Marks a request relayed by a draining host; a draining host never relays it again. Never reaches a unit. */
export const DRAIN_FORWARDED_HEADER = 'x-ontos-drain-forwarded';

/** The app service's hostname on the project's internal network (`zerops-import.yaml`). */
export const APP_SERVICE_HOSTNAME = 'app';

export const DRAIN_FORWARD_CONNECT_TIMEOUT = Duration.seconds(2);
export const DRAIN_FORWARD_HEADERS_TIMEOUT = Duration.seconds(30);

/** A peer container the drain relays to: an address from the internal DNS and the fixed public port. */
export interface DrainPeer {
  readonly address: string;
  readonly port: number;
}

interface DrainCounts {
  readonly failed: number;
  readonly forwarded: number;
  readonly looped: number;
}

/**
 * Whether this host relays, and to whom. `superseded` completes when the drain starts (relayed event streams of the
 * old release end then, so a browser reconnects to the new one); `ended` completes when it ends (in-flight relays
 * are cut then, before the port closes).
 */
export interface SupersedeDrain {
  readonly begin: (peers: readonly DrainPeer[]) => Effect.Effect<void>;
  readonly count: (outcome: keyof DrainCounts) => Effect.Effect<void>;
  readonly ended: Deferred.Deferred<true>;
  readonly finish: Effect.Effect<DrainCounts>;
  readonly peers: Effect.Effect<Option.Option<readonly DrainPeer[]>>;
  readonly superseded: Deferred.Deferred<true>;
}

export const makeSupersedeDrain = (): SupersedeDrain => {
  const peers = Ref.makeUnsafe(Option.none<readonly DrainPeer[]>());
  const counts = Ref.makeUnsafe<DrainCounts>({ failed: 0, forwarded: 0, looped: 0 });
  const superseded = Deferred.makeUnsafe<true>();
  const ended = Deferred.makeUnsafe<true>();
  return {
    begin: (resolved) =>
      Ref.set(peers, resolved.length === 0 ? Option.none() : Option.some(resolved)).pipe(
        Effect.andThen(Deferred.succeed(superseded, true)),
        Effect.asVoid,
      ),
    count: (outcome) => Ref.update(counts, (current) => ({ ...current, [outcome]: current[outcome] + 1 })),
    ended,
    finish: Deferred.succeed(ended, true).pipe(
      Effect.andThen(Ref.set(peers, Option.none())),
      Effect.andThen(Ref.get(counts)),
    ),
    peers: Ref.get(peers),
    superseded,
  };
};

const ownAddresses = () =>
  new Set(
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map(({ address }) => address),
  );

/**
 * The other containers of the app service: the internal DNS answer for the service hostname (the resolver's own
 * records, then the system lookup that also applies the search domain), without this container's addresses.
 * Nothing taken from a request ever chooses the target.
 */
export const platformDrainPeers = (hostname: string, port: number): Effect.Effect<readonly DrainPeer[]> =>
  Effect.gen(function* resolvePeers() {
    const records = yield* Effect.all(
      [
        Effect.tryPromise(async () => await dns.resolve4(hostname)).pipe(
          Effect.orElseSucceed((): readonly string[] => []),
        ),
        Effect.tryPromise(async () => await dns.resolve6(hostname)).pipe(
          Effect.orElseSucceed((): readonly string[] => []),
        ),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map((answers) => answers.flat()));
    const addresses =
      records.length > 0
        ? records
        : yield* Effect.tryPromise(async () => await dns.lookup(hostname, { all: true })).pipe(
            Effect.map((entries) => entries.map(({ address }) => address)),
            Effect.orElseSucceed((): readonly string[] => []),
          );
    const own = ownAddresses();
    return [...new Set(addresses)].filter((address) => !own.has(address)).map((address) => ({ address, port }));
  }).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.succeed([]) }));

const hostLiteral = (address: string) => (address.includes(':') ? `[${address}]` : address);
const describePeers = (peers: readonly DrainPeer[]) =>
  peers.map(({ address, port }) => `${hostLiteral(address)}:${String(port)}`).join(',');

/**
 * Once superseded: relay to the peers for `duration`, or close at once when there is none. A stop signal
 * (interruption) ends the drain early; either way the end is logged with its counts and the port closes.
 */
export const drainSupersededHost = (input: {
  readonly closePublicPort: Effect.Effect<void>;
  readonly drain: SupersedeDrain;
  readonly duration: Duration.Duration;
  readonly peers: Effect.Effect<readonly DrainPeer[]>;
  readonly publicPort: number;
  readonly revision: string;
}) =>
  Effect.gen(function* drainSuperseded() {
    const peers = yield* input.peers;
    const port = String(input.publicPort);
    if (peers.length === 0) {
      yield* input.drain.begin([]);
      yield* Console.log(
        `[app-host] superseded by composition ${input.revision}; no other app container resolves; closing public port ${port} now`,
      );
      yield* input.drain.finish;
      return yield* input.closePublicPort;
    }
    const seconds = String(Duration.toSeconds(input.duration));
    yield* input.drain.begin(peers);
    yield* Console.log(
      `[app-host] superseded by composition ${input.revision}; drain started: public port ${port} relays to ${String(peers.length)} peer(s) ${describePeers(peers)} for up to ${seconds}s`,
    );
    const end = (reason: string) =>
      input.drain.finish.pipe(
        Effect.flatMap(({ failed, forwarded, looped }) =>
          Console.log(
            `[app-host] drain ended (${reason}): forwarded=${String(forwarded)} failed=${String(failed)} looped=${String(looped)}; closing public port ${port}`,
          ),
        ),
        Effect.andThen(input.closePublicPort),
      );
    yield* Effect.sleep(input.duration).pipe(Effect.onInterrupt(() => end('stop signal')));
    return yield* end('deadline');
  });
