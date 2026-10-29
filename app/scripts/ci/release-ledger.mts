/// <reference lib="esnext" />
/// <reference types="node" />
// The stage release ledger: what earlier trusted runs left live on stage, keyed by content digest. GitHub only
// caches it; live state still decides. Each run carries every still-valid record forward and rewrites the ledger
// at its checkpoints, so the newest trusted ledger is normally a superset of the older ones.
// Dependency-free: the plan job reads it before any workspace install.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { inflateRawSync } from 'node:zlib';

import { isJsonObject } from './unit-closure.mts';
import type { JsonObject } from './unit-closure.mts';

export const LEDGER_VERSION = 'ontos-stage-release-ledger-v1';
export const LEDGER_ARTIFACT_NAME = 'stage-release-ledger';
export const LEDGER_FILE = 'stage-release-ledger.json';
/** Immutable Workers outlive build artifacts; a receipt older than this is not trusted to still be live. */
export const RECEIPT_RETENTION_DAYS = 90;
const RECEIPTS_PER_UNIT = 20;
const DAY_MS = 86_400_000;
/** Only these producer runs may supply ledgers or reusable artifacts. */
export const TRUSTED_PRODUCER = Object.freeze({
  branch: 'demo/sales-crm',
  events: Object.freeze(['push', 'workflow_dispatch']),
  workflowPath: '.github/workflows/stage-demo-deploy.yml',
});

const SHA256 = /^[\da-f]{64}$/u;
const SOURCE_REVISION = /^(?:[\da-f]{40}|[\da-f]{64})$/u;
const ZIP_DIRECTORY_END = 0x06_05_4b_50;
const ZIP_DIRECTORY_ENTRY = 0x02_01_4b_50;
const ZIP64_MARKER = 0xff_ff_ff_ff;

export class LedgerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface ReleasePlanIdentity {
  readonly appId: string;
  /** Immutable assets origin. */
  readonly assetsOrigin: string;
  /** Immutable assets Worker. */
  readonly assetsScriptName: string;
  /** Immutable backend Worker. */
  readonly backendScriptName: string;
  readonly buildMarker: string;
  /** Revision the unit was built from. */
  readonly sourceRevision: string;
}

/**
 * Either an ImmutableApplicationReleaseReceipt (module, has `backend`) or an ImmutableShellArtifactReceipt (Shell).
 * Only the fields the plan checks are typed; the rest is carried verbatim for the release scripts to validate.
 */
export interface ReleaseReceipt extends JsonObject {
  /** Artifact hashes. */
  readonly artifacts: JsonObject;
  /** Active assets Worker version. */
  readonly assetsVersionId: string;
  /** Module backend Worker. */
  readonly backend?: JsonObject & { readonly versionId: string; readonly workerName: string };
  readonly plan: ReleasePlanIdentity;
}

export interface UnitRecord {
  /** Unit input digest. */
  readonly digest: string;
  readonly receipt: ReleaseReceipt;
  /** ISO time the receipt was recorded. */
  readonly recordedAt: string;
  /** Producer run. */
  readonly runId: string;
  /** Revision the receipt's Workers were built from. */
  readonly sourceRevision: string;
  readonly unitId: string;
}

export interface HostRecord {
  /** Outbox host input digest. */
  readonly digest: string;
  readonly recordedAt: string;
  readonly runId: string;
  /** Revision the host artifact was built from. */
  readonly sourceRevision: string;
}

export interface DatabaseRecord {
  /** Fingerprint of the database identity credentials. */
  readonly identityFp: string;
  /** Database preparation input digest. */
  readonly inputsDigest: string;
  readonly recordedAt: string;
  readonly runId: string;
  /** Live database catalog fingerprint after a successful preparation. */
  readonly stateHash: string;
}

export interface ReleaseLedger {
  /** Database state after the run's last successful preparation. */
  readonly database: DatabaseRecord | null;
  /** Digest scheme the unit and host digests were computed with. */
  readonly digestVersion: string;
  /** Outbox host the run left deployed. */
  readonly host: HostRecord | null;
  /** Run that wrote this ledger. */
  readonly runId: string;
  /** Revision that run deployed. */
  readonly sourceRevision: string;
  /** Unit records keyed by unit digest. */
  readonly units: Readonly<Record<string, UnitRecord>>;
  /** Ledger schema version. */
  readonly version: string;
  readonly writtenAt: string;
}

export interface RunIdentity {
  readonly digestVersion: string;
  readonly now: Date;
  readonly runId: string;
  readonly sourceRevision: string;
}

const requireString = (object: JsonObject, key: string, where: string, pattern?: RegExp): string => {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw new LedgerError(`${where}.${key} is invalid`);
  }
  return value;
};

const requireObject = (value: unknown, message: string): JsonObject => {
  if (!isJsonObject(value)) {
    throw new LedgerError(message);
  }
  return value;
};

/** A raw receipt of `unitId`, validated as far as the plan relies on it. */
export const parseReceipt = (value: unknown, unitId: string, where: string): ReleaseReceipt => {
  const receipt = requireObject(value, `${where} is not a release receipt`);
  const plan = requireObject(receipt.plan, `${where} is not a release receipt`);
  const artifacts = requireObject(receipt.artifacts, `${where} is not a release receipt`);
  const identity: ReleasePlanIdentity = {
    appId: requireString(plan, 'appId', `${where}.plan`),
    assetsOrigin: requireString(plan, 'assetsOrigin', `${where}.plan`),
    assetsScriptName: requireString(plan, 'assetsScriptName', `${where}.plan`),
    backendScriptName: requireString(plan, 'backendScriptName', `${where}.plan`),
    buildMarker: requireString(plan, 'buildMarker', `${where}.plan`, SHA256),
    sourceRevision: requireString(plan, 'sourceRevision', `${where}.plan`, SOURCE_REVISION),
  };
  if (identity.appId !== unitId) {
    throw new LedgerError(`${where} belongs to ${identity.appId}, not ${unitId}`);
  }
  const assetsVersionId = requireString(receipt, 'assetsVersionId', where);
  if (receipt.backend === undefined) {
    return { ...receipt, artifacts, assetsVersionId, plan: { ...plan, ...identity } };
  }
  const backend = requireObject(receipt.backend, `${where}.backend is invalid`);
  const versionId = requireString(backend, 'versionId', `${where}.backend`);
  const workerName = requireString(backend, 'workerName', `${where}.backend`);
  if (workerName !== identity.backendScriptName) {
    throw new LedgerError(`${where}.backend does not name the receipt's backend Worker`);
  }
  return {
    ...receipt,
    artifacts,
    assetsVersionId,
    backend: { ...backend, versionId, workerName },
    plan: { ...plan, ...identity },
  };
};

const parseUnitRecord = (value: unknown, key: string): UnitRecord => {
  const where = `units.${key}`;
  const record = requireObject(value, `${where} is not an object`);
  const unitId = requireString(record, 'unitId', where);
  if (requireString(record, 'digest', where, SHA256) !== key) {
    throw new LedgerError(`${where} is keyed by another digest`);
  }
  const receipt = parseReceipt(record.receipt, unitId, `${where}.receipt`);
  const sourceRevision = requireString(record, 'sourceRevision', where, SOURCE_REVISION);
  if (sourceRevision !== receipt.plan.sourceRevision) {
    throw new LedgerError(`${where} names another source revision than its receipt`);
  }
  return {
    digest: key,
    receipt,
    recordedAt: requireString(record, 'recordedAt', where),
    runId: requireString(record, 'runId', where),
    sourceRevision,
    unitId,
  };
};

const parseHostRecord = (host: JsonObject): HostRecord => ({
  digest: requireString(host, 'digest', 'host', SHA256),
  recordedAt: requireString(host, 'recordedAt', 'host'),
  runId: requireString(host, 'runId', 'host'),
  sourceRevision: requireString(host, 'sourceRevision', 'host', SOURCE_REVISION),
});

const parseDatabaseRecord = (database: JsonObject): DatabaseRecord => ({
  identityFp: requireString(database, 'identityFp', 'database'),
  inputsDigest: requireString(database, 'inputsDigest', 'database', SHA256),
  recordedAt: requireString(database, 'recordedAt', 'database'),
  runId: requireString(database, 'runId', 'database'),
  stateHash: requireString(database, 'stateHash', 'database', SHA256),
});

/** A ledger document, validated. */
export const parseLedger = (text: string): ReleaseLedger => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LedgerError('the ledger is not valid JSON');
  }
  if (!isJsonObject(value) || value.version !== LEDGER_VERSION || !isJsonObject(value.units)) {
    throw new LedgerError(`the ledger is not a ${LEDGER_VERSION} document`);
  }
  const { database, host, units } = value;
  if ((host !== null && !isJsonObject(host)) || (database !== null && !isJsonObject(database))) {
    throw new LedgerError('the ledger host and database records must be objects or null');
  }
  return {
    database: database === null ? null : parseDatabaseRecord(database),
    digestVersion: requireString(value, 'digestVersion', 'ledger'),
    host: host === null ? null : parseHostRecord(host),
    runId: requireString(value, 'runId', 'ledger'),
    sourceRevision: requireString(value, 'sourceRevision', 'ledger', SOURCE_REVISION),
    units: Object.fromEntries(Object.entries(units).map(([key, record]) => [key, parseUnitRecord(record, key)])),
    version: LEDGER_VERSION,
    writtenAt: requireString(value, 'writtenAt', 'ledger'),
  };
};

/** A ledger of this run with no records. */
export const emptyLedger = ({ digestVersion, now, runId, sourceRevision }: RunIdentity): ReleaseLedger => ({
  database: null,
  digestVersion,
  host: null,
  runId,
  sourceRevision,
  units: {},
  version: LEDGER_VERSION,
  writtenAt: now.toISOString(),
});

/**
 * Every unit record of the given digest scheme within the retention window across earlier ledgers (newest first),
 * newest first, one per digest and source revision. A digest can have receipts from several revisions (a forced
 * rebuild re-uploads an unchanged unit); the plan keeps the newest live one, and an outbox-only retry finds the
 * receipt of each published build marker among them.
 */
export const unitRecordHistory = (
  ledgers: readonly ReleaseLedger[],
  run: Pick<RunIdentity, 'digestVersion' | 'now'>,
): UnitRecord[] => {
  const oldest = run.now.getTime() - RECEIPT_RETENTION_DAYS * DAY_MS;
  const seen = new Set<string>();
  return ledgers
    .filter((ledger) => ledger.digestVersion === run.digestVersion)
    .flatMap((ledger) => Object.values(ledger.units))
    .filter((record) => Date.parse(record.recordedAt) >= oldest)
    .toSorted((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
    .filter((record) => {
      const key = `${record.digest}\0${record.sourceRevision}`;
      const fresh = !seen.has(key);
      seen.add(key);
      return fresh;
    });
};

/**
 * Carries the still-valid records of earlier ledgers (newest first) into a ledger for this run: unit records of the
 * same digest scheme within the retention window, newest per digest, at most a bounded number per unit; and the
 * newest host and database records.
 */
export const mergeLedgers = (ledgers: readonly ReleaseLedger[], run: RunIdentity): ReleaseLedger => {
  const compatible = ledgers.filter((ledger) => ledger.digestVersion === run.digestVersion);
  const units: Record<string, UnitRecord> = {};
  const perUnit = new Map<string, number>();
  for (const record of unitRecordHistory(compatible, run)) {
    const count = perUnit.get(record.unitId) ?? 0;
    if (units[record.digest] === undefined && count < RECEIPTS_PER_UNIT) {
      units[record.digest] = record;
      perUnit.set(record.unitId, count + 1);
    }
  }
  return {
    ...emptyLedger(run),
    database: compatible.find((ledger) => ledger.database !== null)?.database ?? null,
    host: compatible.find((ledger) => ledger.host !== null)?.host ?? null,
    units,
  };
};

export interface UnitReceiptInput {
  readonly digest: string;
  readonly now: Date;
  readonly receipt: unknown;
  readonly runId: string;
  readonly unitId: string;
}

/** The ledger with a fresh receipt recorded under its unit digest. */
export const recordUnitReceipt = (
  ledger: ReleaseLedger,
  { digest, now, receipt, runId, unitId }: UnitReceiptInput,
): ReleaseLedger => {
  const parsed = parseReceipt(receipt, unitId, `receipt for ${unitId}`);
  if (!SHA256.test(digest)) {
    throw new LedgerError(`the ${unitId} digest is invalid`);
  }
  return {
    ...ledger,
    units: {
      ...ledger.units,
      [digest]: {
        digest,
        receipt: parsed,
        recordedAt: now.toISOString(),
        runId,
        sourceRevision: parsed.plan.sourceRevision,
        unitId,
      },
    },
    writtenAt: now.toISOString(),
  };
};

/** The ledger with the outbox host now live. */
export const recordHost = (
  ledger: ReleaseLedger,
  {
    digest,
    now,
    runId,
    sourceRevision,
  }: Pick<HostRecord, 'digest' | 'runId' | 'sourceRevision'> & { readonly now: Date },
): ReleaseLedger => {
  if (!SHA256.test(digest) || !SOURCE_REVISION.test(sourceRevision)) {
    throw new LedgerError('the host record is invalid');
  }
  return {
    ...ledger,
    host: { digest, recordedAt: now.toISOString(), runId, sourceRevision },
    writtenAt: now.toISOString(),
  };
};

/** The ledger with the database state of this run's successful preparation. */
export const recordDatabase = (
  ledger: ReleaseLedger,
  {
    identityFp,
    inputsDigest,
    now,
    runId,
    stateHash,
  }: Pick<DatabaseRecord, 'identityFp' | 'inputsDigest' | 'runId' | 'stateHash'> & { readonly now: Date },
): ReleaseLedger => {
  if (!SHA256.test(inputsDigest) || !SHA256.test(stateHash) || identityFp.length === 0) {
    throw new LedgerError('the database record is invalid');
  }
  return {
    ...ledger,
    database: { identityFp, inputsDigest, recordedAt: now.toISOString(), runId, stateHash },
    writtenAt: now.toISOString(),
  };
};

/** Stable ledger JSON. */
export const serializeLedger = (ledger: ReleaseLedger): string => `${JSON.stringify(ledger, undefined, 2)}\n`;

export interface WorkflowRunIdentity {
  /** Triggering event. */
  readonly event?: string;
  readonly head_branch?: string | null;
  readonly head_repository?: { readonly full_name?: string; readonly id?: number } | null;
  readonly head_sha?: string;
  readonly id: number;
  /** Workflow file. */
  readonly path?: string;
  /** Base repository. */
  readonly repository?: { readonly full_name?: string; readonly id?: number } | null;
}

export interface ArtifactIdentity {
  /** ISO creation time. */
  readonly created_at: string;
  readonly expired: boolean;
  readonly id: number;
  readonly name: string;
  /** Producer run. */
  readonly workflow_run?: {
    readonly head_branch?: string | null;
    readonly head_repository_id?: number;
    readonly head_sha?: string;
    readonly id: number;
    readonly repository_id?: number;
  } | null;
}

/**
 * A producer run counts only when it is this repository's stage deploy workflow, triggered by a push or dispatch on
 * the demo branch from this repository itself (never a fork).
 */
export const isTrustedProducerRun = (run: WorkflowRunIdentity, { repository }: { readonly repository: string }) =>
  run.path === TRUSTED_PRODUCER.workflowPath &&
  TRUSTED_PRODUCER.events.includes(run.event ?? '') &&
  run.head_branch === TRUSTED_PRODUCER.branch &&
  run.repository?.full_name === repository &&
  run.head_repository?.full_name === repository &&
  run.repository.id !== undefined &&
  run.head_repository.id === run.repository.id;

/** Whether an artifact is unexpired and came from a trusted producer run of `owner/name`. */
export const isTrustedArtifact = (
  artifact: ArtifactIdentity,
  run: WorkflowRunIdentity,
  expected: { readonly repository: string },
) =>
  !artifact.expired &&
  artifact.workflow_run?.id === run.id &&
  artifact.workflow_run.head_branch === TRUSTED_PRODUCER.branch &&
  artifact.workflow_run.repository_id !== undefined &&
  artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id &&
  artifact.workflow_run.repository_id === run.repository?.id &&
  (artifact.workflow_run.head_sha === undefined || artifact.workflow_run.head_sha === run.head_sha) &&
  isTrustedProducerRun(run, expected);

/** The entries of a zip archive (stored or deflated, no ZIP64), as GitHub's artifact download endpoint returns. */
export const readZipEntries = (archive: Buffer): Map<string, Buffer> => {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== ZIP_DIRECTORY_END) {
    end -= 1;
  }
  if (end < 0) {
    throw new LedgerError('the artifact archive has no zip directory');
  }
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== ZIP_DIRECTORY_ENTRY) {
      throw new LedgerError('the artifact archive directory is corrupt');
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf-8', offset + 46, offset + 46 + nameLength);
    if (compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new LedgerError('ZIP64 artifact archives are not supported');
    }
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.set(name, data);
    } else if (method === 8) {
      entries.set(name, inflateRawSync(data));
    } else {
      throw new LedgerError(`unsupported zip compression method ${String(method)}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

export interface TrustedArtifact {
  readonly artifact: ArtifactIdentity;
  readonly run: WorkflowRunIdentity;
}

export interface GitHubClient {
  /** Entries of one artifact. */
  readonly downloadArtifact: (artifactId: number) => Promise<Map<string, Buffer>>;
  /** `owner/name`. */
  readonly repository: string;
  /** Up to `limit` unexpired artifacts of that exact name from trusted producer runs, newest first. */
  readonly trustedArtifacts: (name: string, limit: number) => Promise<TrustedArtifact[]>;
}

export interface GitHubClientOptions {
  readonly apiUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly repository: string;
  readonly token: string;
}

const isArtifactIdentity = (value: unknown): value is ArtifactIdentity =>
  isJsonObject(value) &&
  typeof value.id === 'number' &&
  typeof value.name === 'string' &&
  typeof value.expired === 'boolean' &&
  typeof value.created_at === 'string' &&
  (value.workflow_run === undefined ||
    value.workflow_run === null ||
    (isJsonObject(value.workflow_run) && typeof value.workflow_run.id === 'number'));

const isWorkflowRunIdentity = (value: unknown): value is WorkflowRunIdentity =>
  isJsonObject(value) && typeof value.id === 'number';

/** The artifacts of one page of `GET /actions/artifacts`; anything else is an unexpected answer. */
const artifactsPage = (body: unknown): ArtifactIdentity[] => {
  const artifacts = isJsonObject(body) ? body.artifacts : undefined;
  if (!Array.isArray(artifacts) || !artifacts.every(isArtifactIdentity)) {
    throw new LedgerError('GitHub answered an unexpected artifact list');
  }
  return artifacts;
};

/** Read-only GitHub REST client for artifact and run lookups. */
export const createGitHubClient = ({ apiUrl, fetch, repository, token }: GitHubClientOptions): GitHubClient => {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const runs = new Map<number, Promise<WorkflowRunIdentity>>();
  const get = async (route: string): Promise<Response> => {
    const response = await fetch(`${apiUrl}/repos/${repository}${route}`, { headers, redirect: 'follow' });
    if (!response.ok) {
      throw new LedgerError(`GitHub ${route.split('?')[0] ?? route} answered ${String(response.status)}`);
    }
    return response;
  };
  const readRun = async (id: number): Promise<WorkflowRunIdentity> => {
    const response = await get(`/actions/runs/${String(id)}`);
    const body: unknown = await response.json();
    if (!isWorkflowRunIdentity(body)) {
      throw new LedgerError('GitHub answered an unexpected workflow run');
    }
    return body;
  };
  const run = async (id: number): Promise<WorkflowRunIdentity> => {
    const cached = runs.get(id) ?? readRun(id);
    runs.set(id, cached);
    return await cached;
  };
  const trustedOfPage = async (
    candidates: readonly ArtifactIdentity[],
    trusted: readonly TrustedArtifact[],
    limit: number,
  ): Promise<TrustedArtifact[]> => {
    const [artifact, ...rest] = candidates;
    if (artifact === undefined || trusted.length >= limit) {
      return [...trusted];
    }
    const producer = await run(artifact.workflow_run?.id ?? 0);
    const found = isTrustedArtifact(artifact, producer, { repository })
      ? [...trusted, { artifact, run: producer }]
      : trusted;
    return await trustedOfPage(rest, found, limit);
  };
  // GitHub lists artifacts newest first; reading stops as soon as enough trusted ones are found.
  const trustedFromPage = async (
    name: string,
    limit: number,
    page: number,
    trusted: readonly TrustedArtifact[],
  ): Promise<TrustedArtifact[]> => {
    if (page > 10 || trusted.length >= limit) {
      return [...trusted];
    }
    const response = await get(`/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${String(page)}`);
    const artifacts = artifactsPage(await response.json());
    const candidates = artifacts
      .filter((artifact) => artifact.name === name && !artifact.expired)
      .filter((artifact) => artifact.workflow_run?.head_branch === TRUSTED_PRODUCER.branch)
      .toSorted((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    const found = await trustedOfPage(candidates, trusted, limit);
    return artifacts.length < 100 ? found : await trustedFromPage(name, limit, page + 1, found);
  };
  return {
    downloadArtifact: async (artifactId) => {
      const response = await get(`/actions/artifacts/${String(artifactId)}/zip`);
      return readZipEntries(Buffer.from(await response.arrayBuffer()));
    },
    repository,
    trustedArtifacts: async (name, limit) => await trustedFromPage(name, limit, 1, []),
  };
};

/** The newest trusted ledgers, newest first. A ledger that cannot be read or parsed fails the lookup. */
export const readTrustedLedgers = async (client: GitHubClient, limit: number): Promise<ReleaseLedger[]> => {
  const artifacts = await client.trustedArtifacts(LEDGER_ARTIFACT_NAME, limit);
  const entries = await Promise.all(artifacts.map(async ({ artifact }) => await client.downloadArtifact(artifact.id)));
  return entries.map((files, index) => {
    const entry = files.get(LEDGER_FILE);
    if (entry === undefined) {
      throw new LedgerError(`ledger artifact ${String(artifacts[index]?.artifact.id)} has no ${LEDGER_FILE}`);
    }
    return parseLedger(entry.toString('utf-8'));
  });
};

const writeLedgerFile = (file: string, ledger: ReleaseLedger) => {
  writeFileSync(`${file}.tmp`, serializeLedger(ledger), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

const readJsonFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf-8'));

const USAGE = `Usage:
  release-ledger.mts init --plan <deploy-plan.json> --output <ledger.json>
  release-ledger.mts record-unit --ledger <f> --unit <id> --digest <d> --receipt-file <f>
  release-ledger.mts record-host --ledger <f> --digest <d> --source-revision <r>
  release-ledger.mts record-database --ledger <f> --inputs-digest <d> --identity-fp <fp> --state-hash <h>`;

/** The ledger a deploy plan carries forward. */
const carriedLedger = (plan: unknown): ReleaseLedger => {
  if (!isJsonObject(plan) || !isJsonObject(plan.ledger)) {
    throw new LedgerError('the deploy plan carries no ledger');
  }
  return parseLedger(JSON.stringify(plan.ledger));
};

const main = (argv: readonly string[], env: NodeJS.ProcessEnv) => {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      digest: { type: 'string' },
      'identity-fp': { type: 'string' },
      'inputs-digest': { type: 'string' },
      ledger: { type: 'string' },
      output: { type: 'string' },
      plan: { type: 'string' },
      'receipt-file': { type: 'string' },
      'source-revision': { type: 'string' },
      'state-hash': { type: 'string' },
      unit: { type: 'string' },
    },
    strict: true,
  });
  const now = new Date();
  const runId = env.GITHUB_RUN_ID ?? 'local';
  const required = (value: string | undefined, name: string): string => {
    if (value === undefined || value.length === 0) {
      throw new LedgerError(`--${name} is required\n${USAGE}`);
    }
    return value;
  };
  if (command === 'init') {
    const carried = carriedLedger(readJsonFile(required(values.plan, 'plan')));
    writeLedgerFile(required(values.output, 'output'), { ...carried, runId, writtenAt: now.toISOString() });
    return;
  }
  const file = required(values.ledger, 'ledger');
  const ledger = parseLedger(readFileSync(file, 'utf-8'));
  if (command === 'record-unit') {
    writeLedgerFile(
      file,
      recordUnitReceipt(ledger, {
        digest: required(values.digest, 'digest'),
        now,
        receipt: readJsonFile(required(values['receipt-file'], 'receipt-file')),
        runId,
        unitId: required(values.unit, 'unit'),
      }),
    );
  } else if (command === 'record-host') {
    writeLedgerFile(
      file,
      recordHost(ledger, {
        digest: required(values.digest, 'digest'),
        now,
        runId,
        sourceRevision: required(values['source-revision'], 'source-revision'),
      }),
    );
  } else if (command === 'record-database') {
    writeLedgerFile(
      file,
      recordDatabase(ledger, {
        identityFp: required(values['identity-fp'], 'identity-fp'),
        inputsDigest: required(values['inputs-digest'], 'inputs-digest'),
        now,
        runId,
        stateHash: required(values['state-hash'], 'state-hash'),
      }),
    );
  } else {
    throw new LedgerError(USAGE);
  }
};

if (import.meta.main) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
