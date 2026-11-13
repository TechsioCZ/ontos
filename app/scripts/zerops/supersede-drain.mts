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

import { Clock, Console, Deferred, Duration, Effect, FileSystem, Option, Ref, Schedule, Schema } from 'effect';

/**
 * How long a superseded host relays: the readiness probe period (`zerops.yaml` app `retryPeriod: 10s`) plus the
 * balancer's reconfiguration (measured: about 8 s), 2.5 times over. A stop signal ends it earlier: the platform stops
 * the old container only once traffic moved to the new one.
 */
export const SUPERSEDED_DRAIN = Duration.seconds(45);

/** Marks a request relayed by a draining host; a draining host never relays it again. Never reaches a unit. */
export const DRAIN_FORWARDED_HEADER = 'x-ontos-drain-forwarded';

/**
 * Marks a draining host's refusal of a relayed request, so the host that relayed it drops that peer for the rest of
 * its drain and tries the next one (two deploys in a row: the middle container drains too).
 */
export const DRAIN_REFUSED_HEADER = 'x-ontos-drain-refused';

/** Peers are resolved again only when every known one failed, and then at most once per second. */
export const DRAIN_PEER_RESOLVE_INTERVAL = Duration.seconds(1);

/** At supersede, an empty DNS answer is asked again every 500 ms for 5 s before the port closes. */
export const DRAIN_PEER_FIRST_RESOLVE_RETRY = Duration.millis(500);
export const DRAIN_PEER_FIRST_RESOLVE_ATTEMPTS = 10;

/** The app service's hostname on the project's internal network (`zerops-import.yaml`). */
export const APP_SERVICE_HOSTNAME = 'app';

export const DRAIN_FORWARD_CONNECT_TIMEOUT = Duration.seconds(2);
/** The direct relay's own bound: a relayed request waits for its answer as long as a direct one would. */
export const DRAIN_FORWARD_HEADERS_TIMEOUT = Duration.seconds(60);

/** A peer container the drain relays to: an address from the internal DNS and the fixed public port. */
export interface DrainPeer {
  readonly address: string;
  readonly port: number;
}

interface DrainCounts {
  readonly dropped: number;
  readonly failed: number;
  readonly forwarded: number;
  readonly looped: number;
}

const peerKey = ({ address, port }: DrainPeer) => `${address}:${String(port)}`;

/**
 * Whether this host relays, and to whom. `superseded` completes when the drain starts (relayed event streams of the
 * old release end then, so a browser reconnects to the new one); `ended` completes when it ends (in-flight relays
 * are cut then, before the port closes). A peer that refused as draining itself, or refused the connection, is
 * dropped for the rest of the drain; `refresh` asks the resolver again, at most once per second.
 */
export interface SupersedeDrain {
  readonly active: Effect.Effect<boolean>;
  readonly begin: (peers: readonly DrainPeer[], resolve: Effect.Effect<readonly DrainPeer[]>) => Effect.Effect<void>;
  readonly count: (outcome: keyof DrainCounts) => Effect.Effect<void>;
  /**
   * `draining`: the peer refused as a draining host itself, and stays dropped for the rest of the drain. `refused`: it
   * refused the connection (a new host's listener a few milliseconds late), and is tried again after the next
   * resolution.
   */
  readonly drop: (peer: DrainPeer, reason: 'draining' | 'refused') => Effect.Effect<void>;
  readonly ended: Deferred.Deferred<true>;
  readonly finish: Effect.Effect<DrainCounts>;
  readonly livePeers: Effect.Effect<readonly DrainPeer[]>;
  readonly refresh: Effect.Effect<readonly DrainPeer[]>;
  /**
   * Completes before the public port closes (drain end or stop signal): every relayed event stream ends, every other
   * relayed response is cut and every relay still waiting for its answer (an upload in flight) answers 503, so the
   * port's graceful close never waits on them.
   */
  readonly stopping: Deferred.Deferred<true>;
  readonly superseded: Deferred.Deferred<true>;
}

interface DrainState {
  readonly active: boolean;
  readonly dropped: ReadonlySet<string>;
  readonly peers: readonly DrainPeer[];
  readonly refused: ReadonlySet<string>;
  readonly resolve: Effect.Effect<readonly DrainPeer[]>;
  readonly resolvedAt: number;
}

export const makeSupersedeDrain = (): SupersedeDrain => {
  const state = Ref.makeUnsafe<DrainState>({
    active: false,
    dropped: new Set(),
    peers: [],
    refused: new Set(),
    resolve: Effect.succeed([]),
    resolvedAt: 0,
  });
  const counts = Ref.makeUnsafe<DrainCounts>({ dropped: 0, failed: 0, forwarded: 0, looped: 0 });
  const superseded = Deferred.makeUnsafe<true>();
  const ended = Deferred.makeUnsafe<true>();
  const stopping = Deferred.makeUnsafe<true>();
  const live = ({ dropped, peers, refused }: DrainState) =>
    peers.filter((peer) => !dropped.has(peerKey(peer)) && !refused.has(peerKey(peer)));
  const count = (outcome: keyof DrainCounts) =>
    Ref.update(counts, (current) => ({ ...current, [outcome]: current[outcome] + 1 }));
  return {
    active: Ref.get(state).pipe(Effect.map(({ active }) => active)),
    begin: (peers, resolve) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(state, (current) => ({ ...current, active: peers.length > 0, peers, resolve, resolvedAt: now })),
        ),
        Effect.andThen(Deferred.succeed(superseded, true)),
        Effect.asVoid,
      ),
    count,
    drop: (peer, reason) =>
      Ref.modify(state, (current) => {
        const key = peerKey(peer);
        if (current.dropped.has(key) || (reason === 'refused' && current.refused.has(key))) {
          return [false, current];
        }
        return reason === 'draining'
          ? [true, { ...current, dropped: new Set([...current.dropped, key]) }]
          : [true, { ...current, refused: new Set([...current.refused, key]) }];
      }).pipe(Effect.flatMap((added) => (added ? count('dropped') : Effect.void))),
    ended,
    // The drain stays active after its end: a request still arriving on a connection that was open when the listener
    // closed is relayed too, never served by this superseded release.
    finish: Deferred.succeed(ended, true).pipe(Effect.andThen(Ref.get(counts))),
    livePeers: Ref.get(state).pipe(Effect.map(live)),
    refresh: Effect.gen(function* refreshPeers() {
      const now = yield* Clock.currentTimeMillis;
      const current = yield* Ref.get(state);
      if (now - current.resolvedAt < Duration.toMillis(DRAIN_PEER_RESOLVE_INTERVAL)) {
        return live(current);
      }
      const peers = yield* current.resolve;
      // A peer that only refused a connection gets another chance; a draining one does not.
      const next = yield* Ref.updateAndGet(state, (latest) => ({
        ...latest,
        peers,
        refused: new Set<string>(),
        resolvedAt: now,
      }));
      return live(next);
    }),
    stopping,
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
  readonly drain: SupersedeDrain;
  readonly duration: Duration.Duration;
  readonly peers: Effect.Effect<readonly DrainPeer[]>;
  readonly publicPort: number;
  readonly revision: string;
  /** Stops accepting connections; requests already relayed finish (only the stop signal cuts them). */
  readonly stopAccepting: Effect.Effect<void>;
}) =>
  Effect.gen(function* drainSuperseded() {
    // The new container's address may reach the internal DNS a moment after its publication: ask again for a while
    // before concluding that there is no other container.
    const peers = yield* input.peers.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(DRAIN_PEER_FIRST_RESOLVE_RETRY),
        times: DRAIN_PEER_FIRST_RESOLVE_ATTEMPTS - 1,
        until: (resolved) => resolved.length > 0,
      }),
    );
    const port = String(input.publicPort);
    if (peers.length === 0) {
      yield* input.drain.begin([], input.peers);
      yield* Console.log(
        `[app-host] superseded by composition ${input.revision}; no other app container resolves; closing public port ${port} now`,
      );
      yield* input.drain.finish;
      return yield* input.stopAccepting;
    }
    const seconds = String(Duration.toSeconds(input.duration));
    yield* input.drain.begin(peers, input.peers);
    yield* Console.log(
      `[app-host] superseded by composition ${input.revision}; drain started: public port ${port} relays to ${String(peers.length)} peer(s) ${describePeers(peers)} for up to ${seconds}s`,
    );
    const end = (reason: string) =>
      input.drain.finish.pipe(
        Effect.flatMap(({ dropped, failed, forwarded, looped }) =>
          Console.log(
            `[app-host] drain ended (${reason}): forwarded=${String(forwarded)} failed=${String(failed)} looped=${String(looped)} dropped=${String(dropped)}; closing public port ${port}`,
          ),
        ),
      );
    // On a stop signal the host's own stop closes the port (and cuts what is still relayed); here only the end is told.
    yield* Effect.sleep(input.duration).pipe(Effect.onInterrupt(() => end('stop signal')));
    yield* end('deadline');
    // The deadline is not a stop: event streams end (`finish`), the listener closes, relays in flight finish.
    return yield* input.stopAccepting;
  });

/** When this container first started an app host, and whether this start is a restart inside the same container. */
export interface ContainerBoot {
  readonly firstBootMillis: number;
  readonly restart: boolean;
}

const decodeFirstBoot = Schema.decodeUnknownOption(Schema.NumberFromString);

/**
 * Reads the container's first-boot marker, writing it (this host's clock, in milliseconds) on the first start. The
 * marker lives in container-local storage (`ONTOS_APP_HOST_BOOT_MARKER`, `/tmp` on Zerops): the platform restarts a
 * process inside its container, while every deploy starts new containers without it. An unreadable marker counts as a
 * first boot, which is how a host behaved before the marker existed: it is written again, and when the file cannot be
 * read or written at all, one WARN line says so and the host goes on. The marker never costs availability.
 */
export const containerBoot = (marker: string) =>
  Effect.gen(function* readContainerBoot() {
    const now = yield* Clock.currentTimeMillis;
    const firstBoot = { firstBootMillis: now, restart: false } satisfies ContainerBoot;
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* readOrWriteMarker() {
      const recorded = (yield* fs.exists(marker))
        ? decodeFirstBoot((yield* fs.readFileString(marker)).trim())
        : Option.none<number>();
      if (Option.isSome(recorded)) {
        return { firstBootMillis: recorded.value, restart: true } satisfies ContainerBoot;
      }
      yield* fs.writeFileString(marker, `${String(now)}\n`);
      return firstBoot;
    }).pipe(
      Effect.catch((error) =>
        Console.error(
          `[app-host] WARN first-boot marker ${marker} unusable (${error.reason._tag}); starting as a first boot`,
        ).pipe(Effect.as(firstBoot)),
      ),
    );
  });

/** The release that holds the authority row, and when (database clock, milliseconds) its revision took it. */
export interface AuthorityHolder {
  readonly activatedAtMillis: number;
  readonly revision: string;
}

/**
 * Whether a host that starts may publish its release. A process that crashed and was restarted inside an old
 * container would otherwise publish its old release over the newer one that took the authority meanwhile (the old
 * container is not stopped while its process restarts). So a restart refuses when the row names another revision
 * that took the authority after this container first booted: that release is newer than this container. A first
 * boot, a restart of the release that holds the row, and a restart before any newer release took over publish as
 * before. The two clocks (container and database) only meet across a deploy, minutes apart.
 */
export const restartMayPublish = (input: {
  readonly boot: Option.Option<ContainerBoot>;
  readonly holder: Option.Option<AuthorityHolder>;
  readonly ownRevision: string;
}) =>
  Option.match(input.boot.pipe(Option.filter(({ restart }) => restart)), {
    onNone: () => true,
    onSome: ({ firstBootMillis }) =>
      Option.match(input.holder, {
        onNone: () => true,
        onSome: ({ activatedAtMillis, revision }) =>
          revision === input.ownRevision || activatedAtMillis <= firstBootMillis,
      }),
  });

/**
 * Whether this host may write the authority row now. Never once it was superseded; after its first publication only
 * while the row still names its own revision (a failed read refuses: it cannot prove it still holds the authority).
 * A superseded host that published again would take the authority back from the newer release.
 */
export const publicationAllowed = <E, R>(input: {
  readonly activeRevision: Effect.Effect<Option.Option<string>, E, R>;
  readonly ownRevision: Option.Option<string>;
  readonly superseded: Deferred.Deferred<true>;
}) =>
  Effect.gen(function* allowPublication() {
    if (yield* Deferred.isDone(input.superseded)) {
      return false;
    }
    if (Option.isNone(input.ownRevision)) {
      return true;
    }
    const own = input.ownRevision.value;
    const active = yield* input.activeRevision.pipe(Effect.option, Effect.map(Option.flatten));
    return Option.isSome(active) && active.value === own;
  });

/**
 * Renews the authority every `interval` while this host holds it, and never again once it was superseded: the loop
 * then idles for the rest of the host's life (the host neither exits nor publishes; an exit would let the platform
 * restart this old release, whose boot would publish again).
 */
export const renewWhileHolding = <E, R>(input: {
  readonly interval: Duration.Duration;
  readonly renew: Effect.Effect<unknown, E, R>;
  readonly superseded: Deferred.Deferred<true>;
}): Effect.Effect<never, E, R> =>
  Effect.gen(function* renewAuthority() {
    for (;;) {
      const superseded = yield* Effect.raceFirst(
        Effect.sleep(input.interval).pipe(Effect.as(false)),
        Deferred.await(input.superseded),
      );
      if (superseded) {
        yield* Console.log('[app-host] superseded: this host never renews or publishes the authority again');
        return yield* Effect.never;
      }
      yield* input.renew;
    }
  });
