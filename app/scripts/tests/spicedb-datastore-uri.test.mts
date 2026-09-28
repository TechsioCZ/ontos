import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/unstable/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const builder = fileURLToPath(new URL('../spicedb-datastore-uri.sh', import.meta.url));

interface DatastoreParts {
  readonly host: string;
  readonly password: string;
  readonly port: string;
}

const run = (command: string, args: readonly string[], env: Record<string, string> = {}) =>
  collectToolingProcess(
    ChildProcess.make(command, args, { env, extendEnv: true, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' }),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const build = (parts: DatastoreParts) =>
  run('/bin/sh', [builder], {
    SPICEDB_DATABASE_HOST: parts.host,
    SPICEDB_DATABASE_PASSWORD: parts.password,
    SPICEDB_DATABASE_PORT: parts.port,
  });

// Documentation-range addresses (RFC 5737 / RFC 3849) and loopback cover IPv4, IPv6 and mapped hosts.
const cases: readonly DatastoreParts[] = [
  { host: 'db18', password: 'plain', port: '5432' },
  { host: 'db18', password: 'p@ss:w/o%rd#?', port: '5432' },
  { host: 'db18', password: ' two words ', port: '5432' },
  { host: 'db.internal.example', password: "%25%ZZ@@//??##::'!$&()*+,;=[]", port: '65535' },
  { host: '192.0.2.7', password: 'žluťoučký kůň', port: '1' },
  { host: '::1', password: 'p@ss', port: '5433' },
  { host: '2001:db8::7', password: 'a:b@c', port: '5432' },
  { host: '2001:db8::c0:a8', password: '#', port: '5432' },
];

it.live(
  'builds a datastore URI that decodes back to exactly its structured parts',
  Effect.fn(function* roundTripEffect() {
    for (const parts of cases) {
      const result = yield* build(parts);
      expect(result.status, result.stderr).toBe(0);
      const uri = new URL(result.stdout.trim());
      expect(uri.protocol).toBe('postgresql:');
      expect(decodeURIComponent(uri.username)).toBe('spicedb');
      expect(decodeURIComponent(uri.password)).toBe(parts.password);
      expect(uri.hostname).toBe(parts.host.includes(':') ? `[${parts.host}]` : parts.host);
      expect(uri.port).toBe(parts.port);
      expect(uri.pathname).toBe('/spicedb');
      expect(uri.search).toBe('');
      expect(uri.hash).toBe('');
    }
  }),
);

it.live(
  'rejects structured parts that are missing or malformed',
  Effect.fn(function* rejectionEffect() {
    for (const parts of [
      { host: '', password: 'secret', port: '5432' },
      { host: 'db18', password: '', port: '5432' },
      { host: 'db18', password: 'secret', port: '' },
      { host: 'db18', password: 'secret', port: '0' },
      { host: 'db18', password: 'secret', port: '65536' },
      { host: 'db18', password: 'secret', port: '54a2' },
      { host: 'db18/other', password: 'secret', port: '5432' },
      { host: 'user@db18', password: 'secret', port: '5432' },
      { host: '-db18', password: 'secret', port: '5432' },
      { host: '[::1]', password: 'secret', port: '5432' },
    ]) {
      expect((yield* build(parts)).status).not.toBe(0);
    }
  }),
);

// SpiceDB parses its datastore URI with Go's net/url; prove that exact parse wherever Go is installed.
const goParser = `package main

import (
\t"encoding/json"
\t"net/url"
\t"os"
)

func main() {
\tparsed, err := url.Parse(os.Args[1])
\tif err != nil {
\t\tpanic(err)
\t}
\tpassword, _ := parsed.User.Password()
\t_ = json.NewEncoder(os.Stdout).Encode(map[string]string{
\t\t"hostname": parsed.Hostname(), "password": password, "path": parsed.Path,
\t\t"port": parsed.Port(), "user": parsed.User.Username(),
\t})
}
`;

const GoParseSchema = Schema.fromJsonString(
  Schema.Struct({
    hostname: Schema.String,
    password: Schema.String,
    path: Schema.String,
    port: Schema.String,
    user: Schema.String,
  }),
);

it.live(
  'builds a datastore URI that Go net/url parses back to its structured parts',
  Effect.fn(function* goParseEffect() {
    const go = yield* run('go', ['version']).pipe(Effect.orElseSucceed(() => ({ status: 1, stderr: '', stdout: '' })));
    if (go.status !== 0) {
      return;
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'spicedb-datastore-uri-'));
    try {
      const program = path.join(directory, 'main.go');
      const binary = path.join(directory, 'parse-url');
      writeFileSync(program, goParser);
      const compiled = yield* run('go', ['build', '-o', binary, program], {
        GO111MODULE: 'off',
        GOCACHE: path.join(directory, 'cache'),
      });
      expect(compiled.status, compiled.stderr).toBe(0);
      for (const parts of cases) {
        const parsed = yield* run(binary, [(yield* build(parts)).stdout.trim()]);
        expect(parsed.status, parsed.stderr).toBe(0);
        expect(Schema.decodeUnknownSync(GoParseSchema)(parsed.stdout.trim())).toEqual({
          hostname: parts.host,
          password: parts.password,
          path: '/spicedb',
          port: parts.port,
          user: 'spicedb',
        });
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);
