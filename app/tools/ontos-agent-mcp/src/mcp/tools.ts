/**
 * Connection tools (lane mcp-mcp-rs): the per-request MCP tool list. Generic ontos_* tools plus typed tools, both
 * filtered by the ConnectionDescription (grant, modules, write policy). Failures are Czech tool results, never throws.
 */
import { randomUUID } from 'node:crypto';
import { Schema } from 'effect';
import type { Catalog, CatalogAction, CatalogEntry, JsonSchema } from '../capabilities/types.ts';
import {
  entryDescriptionCs,
  entryTitleCs,
  moduleDescriptionCs,
  moduleKeywordsCs,
  moduleLabelCs,
  WRITE_POLICY_CS,
} from '../catalog/labels-cs.ts';
import { ConnectionInactiveError } from '../oauth/types.ts';
import { OntosRequestError } from '../ontos-client.ts';
import { findEntry, findModule, ReadPathError, runExecute, runRead, toJsonObject } from '../operations.ts';
import { czechProblem } from './errors-cs.ts';
import { inputProblems } from './input-check.ts';
import {
  CAPABILITIES_OUTPUT,
  PROPOSALS_OUTPUT,
  READ_OUTPUT,
  WHOAMI_OUTPUT,
  WRITE_OUTPUT,
} from './output-schemas.ts';
import { directReplays, requestHash } from './replay.ts';
import { matchesTokens, queryTokens } from './search.ts';
import {
  ProposalsEndpointMissingError,
  listProposals,
  submitProposals,
} from './proposals.ts';
import type { ProposalInput, ProposalsTarget } from './proposals.ts';
import {
  acceptsProposals,
  actionAvailability,
  annotationsFor,
  canPropose,
  canRead,
  canWrite,
  grantAllowsWrite,
  isOffered,
  planTools,
} from './tool-plan.ts';
import type { GenericToolName } from './tool-plan.ts';
import type { ConnectionContext, ToolAnnotationsSpec, ToolContent, ToolDeps, ToolResult, ToolSpec } from './types.ts';

export const MSG_READ_ONLY =
  'Toto připojení smí jen číst. Změnu udělejte přímo v OntOS, nebo aplikaci připojte znovu s jiným režimem zápisu.';
export const MSG_NO_WRITE = (label: string): string => `Toto připojení nesmí měnit modul ${label}.`;
export const MSG_NO_READ = (label: string): string => `Toto připojení nemá přístup k modulu ${label}.`;
export const MSG_UNKNOWN = (id: string): string => `Neznámé id ${id}. Seznam vrací ontos_capabilities.`;
export const MSG_AI_META = 'Tuto akci nelze volat přes MCP.';
export const MSG_DEMO_MAINTENANCE = 'Údržbu ukázkových dat připojené aplikace nedělají; udělejte ji přímo v OntOS.';
export const MSG_HUMAN_ONLY =
  'Tuto změnu smí v modulu udělat jen člověk přímo v OntOS. Připojená aplikace ji může jen navrhnout ke schválení (ontos_propose).';
export const MSG_NO_PROPOSALS = (label: string): string =>
  `Modul ${label} zatím nepřijímá návrhy ke schválení, takže ho toto připojení měnit nemůže. Změnu udělejte přímo v OntOS.`;
export const MSG_INVALID_INPUT = (id: string, problems: string): string =>
  `Vstup pro ${id} neodpovídá schématu: ${problems}. Správné schéma vrátí ontos_capabilities {id: "${id}"}.`;
export const MSG_IDEMPOTENCY_CONFLICT =
  'Stejný klíč idempotencyKey už byl použit pro jinou změnu. Pro novou změnu pošlete nový klíč (nebo ho vynechte).';
/** Shell pages of the modules (link in direct write results). */
export const MODULE_PAGE: Readonly<Record<string, string>> = {
  'facility.operations': '/cs/provoz',
  'finance.billing': '/cs/finance',
  'legal.agreements': '/cs/smlouvy',
  'property.leasing': '/cs/najmy',
  'property.portfolio': '/cs/nemovitosti',
  'work.tasks': '/cs/ukoly',
};
export const MSG_PROPOSED = 'Návrh čeká na schválení v OntOS (Nastavení › Ke schválení). Data se zatím nezměnila.';
export const MSG_EXECUTED = 'Změna je provedena a zapsána do deníku.';

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const okResult = (value: unknown, links: readonly ToolContent[] = []): ToolResult => ({
  content: [{ text: JSON.stringify(value), type: 'text' }, ...links],
  structuredContent: isPlainObject(value) ? value : { value },
});

export const errorResult = (message: string, meta?: Readonly<Record<string, unknown>>): ToolResult => ({
  content: [{ text: message, type: 'text' }],
  isError: true,
  ...(meta ? { _meta: meta } : {}),
});

const isOntosRequestError = Schema.is(OntosRequestError);

const toolError = (error: unknown, deps: ToolDeps): ToolResult => {
  if (error instanceof ConnectionInactiveError || (isOntosRequestError(error) && error.status === 401)) {
    return errorResult('Připojení k OntOS už neplatí. Připojte aplikaci znovu.', {
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${deps.config.prmUrl}", scope="ontos", error="invalid_token"`,
      ],
    });
  }
  if (isOntosRequestError(error)) {
    const problem = czechProblem(error);
    return errorResult(problem.text, problem.meta);
  }
  if (error instanceof ReadPathError) {
    return errorResult(error.message);
  }
  return errorResult(error instanceof Error ? error.message : String(error));
};

const stringArg = (args: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
};
const intArg = (args: Readonly<Record<string, unknown>>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};
const objectArg = (
  args: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined => {
  const value = args[key];
  return isPlainObject(value) ? value : undefined;
};

const withoutRevision = (input: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const fields: Record<string, unknown> = { ...input };
  delete fields['expectedRevision'];
  return fields;
};

interface ProposeItem {
  readonly entry: CatalogAction;
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly summary: string;
  readonly targetLabel: string;
}

type WriteTarget = { readonly entry: CatalogAction } | { readonly error: ToolResult };

/** Tool list of one request: generic ontos_* tools in plan order, then typed tools. */
/** Optional fields every typed write tool gets in addition to the Action input (only when the Action has no such field). */
const TYPED_WRITE_EXTRAS: Readonly<Record<string, JsonSchema>> = {
  idempotencyKey: {
    description: 'Stejný klíč při opakování vrátí původní výsledek a nic nezmění dvakrát.',
    maxLength: 200,
    minLength: 1,
    type: 'string',
  },
  reason: { description: 'Proč změnu děláš (uvidí schvalovatel).', maxLength: 2000, type: 'string' },
};

const typedWriteSchema = (schema: JsonSchema): { readonly schema: JsonSchema; readonly extras: readonly string[] } => {
  const properties = isPlainObject(schema['properties']) ? schema['properties'] : {};
  const extras = Object.keys(TYPED_WRITE_EXTRAS).filter((key) => !Object.hasOwn(properties, key));
  if (extras.length === 0) {
    return { extras, schema };
  }
  return {
    extras,
    schema: {
      ...schema,
      properties: { ...properties, ...Object.fromEntries(extras.map((key) => [key, TYPED_WRITE_EXTRAS[key]])) },
    },
  };
};

const READ_NOTE_CS =
  'Výsledek je zkrácený. Další položky seznamu: stejné volání s offset. Vynechané části (omitted) načtěte přes ontos_read {id, path}.';

/** Tool list of one request: generic ontos_* tools in plan order, then typed tools. */
export const buildConnectionTools = async (
  connection: ConnectionContext,
  deps: ToolDeps,
): Promise<readonly ToolSpec[]> => {
  const d = connection.description;
  const catalog: Catalog = await deps.getCatalog();
  const plan = planTools(catalog, d);
  const labelOf = (moduleId: string): string =>
    d.modules.find((module) => module.moduleId === moduleId)?.label ||
    moduleLabelCs(moduleId, findModule(catalog, moduleId)?.displayName ?? moduleId);
  const moduleIdOf = (id: string, entry: CatalogEntry | undefined): string => entry?.moduleId ?? id.split('/')[0] ?? '';
  const target: ProposalsTarget = {
    fetchFn: deps.fetchFn,
    session: connection.session,
    shellUrl: deps.config.shellInternalUrl,
  };
  const reviewUrl = `${deps.config.shellPublicUrl}/cs/sprava/ke-schvaleni`;
  const reviewLink = (url: string): ToolContent => ({
    description: 'Návrh schválí nebo zamítne člověk v OntOS.',
    mimeType: 'text/html',
    name: 'ke-schvaleni',
    title: 'OntOS › Ke schválení',
    type: 'resource_link',
    uri: url,
  });
  const moduleLink = (moduleId: string): ToolContent | undefined => {
    const page = MODULE_PAGE[moduleId];
    return page === undefined
      ? undefined
      : {
          mimeType: 'text/html',
          name: moduleId,
          title: `OntOS › ${labelOf(moduleId)}`,
          type: 'resource_link',
          uri: `${deps.config.shellPublicUrl}${page}`,
        };
  };

  const instrument = (
    name: string,
    title: string,
    description: string,
    inputSchema: JsonSchema,
    annotations: ToolAnnotationsSpec,
    run: (args: Readonly<Record<string, unknown>>) => Promise<ToolResult>,
    outputSchema?: JsonSchema,
  ): ToolSpec => ({
    annotations,
    description,
    handler: async (args) => {
      const started = Date.now();
      let result: ToolResult;
      try {
        // The SDK does not validate (its messages are English); a wrong call gets a Czech explanation here.
        const problems = inputProblems(inputSchema, args);
        result =
          problems === undefined
            ? await run(args)
            : errorResult(`Neplatné argumenty nástroje ${name}: ${problems}.`, { 'ontos/code': 'invalid_arguments' });
      } catch (error) {
        result = toolError(error, deps);
      }
      const ms = Date.now() - started;
      process.stderr.write(
        `${JSON.stringify({ event: 'mcp.tool', tool: name, grantId: d.grantId, ms, outcome: result.isError === true ? 'error' : 'ok' })}\n`,
      );
      return result;
    },
    inputSchema,
    name,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    title,
  });

  const runReadTool = async (
    id: string,
    input: Readonly<Record<string, unknown>> | undefined,
    options: { readonly limit?: number; readonly offset?: number; readonly path?: string } = {},
  ): Promise<ToolResult> => {
    const entry = findEntry(catalog, id);
    const moduleId = moduleIdOf(id, entry);
    if (!canRead(d, moduleId)) {
      return errorResult(MSG_NO_READ(labelOf(moduleId)));
    }
    if (entry === undefined || entry.kind !== 'read') {
      return errorResult(MSG_UNKNOWN(id));
    }
    const problems = inputProblems(entry.inputSchema, input ?? {}, 'input');
    if (problems !== undefined) {
      return errorResult(MSG_INVALID_INPUT(entry.id, problems), { 'ontos/code': 'invalid_input' });
    }
    const read = await runRead(connection.session, catalog, {
      id: entry.id,
      input: toJsonObject(input ?? {}),
      limit: options.limit,
      offset: options.offset,
      ...(options.path === undefined ? {} : { path: options.path }),
    });
    const shortened = read.truncated.length > 0 || read.omitted.length > 0;
    return okResult(shortened ? { ...read, noteCs: READ_NOTE_CS } : read);
  };

  const writeTargetOf = (id: string, mode: 'write' | 'propose' = 'write'): WriteTarget => {
    if (d.writePolicy === 'read_only') {
      return { error: errorResult(MSG_READ_ONLY) };
    }
    const entry = findEntry(catalog, id);
    const moduleId = moduleIdOf(id, entry);
    // Before the unknown-id check: writes outside the grant always say "nesmí měnit".
    if (!grantAllowsWrite(d, moduleId)) {
      return { error: errorResult(MSG_NO_WRITE(labelOf(moduleId))) };
    }
    if (entry === undefined || entry.kind !== 'action') {
      return { error: errorResult(MSG_UNKNOWN(id)) };
    }
    // ontos_propose always proposes, so human-only commands are fine there; everything else follows the policy.
    const availability = actionAvailability(entry, mode === 'propose' ? 'approval' : d.writePolicy, d.acting.kind);
    if (availability === 'ai_meta') {
      return { error: errorResult(MSG_AI_META) };
    }
    if (availability === 'demo_maintenance') {
      return { error: errorResult(MSG_DEMO_MAINTENANCE) };
    }
    if (availability === 'human_only') {
      return { error: errorResult(MSG_HUMAN_ONLY) };
    }
    const allowed = mode === 'propose' ? canPropose(d, moduleId) : canWrite(d, moduleId);
    if (!allowed) {
      return { error: errorResult(MSG_NO_PROPOSALS(labelOf(moduleId))) };
    }
    return { entry };
  };

  const checkActionInput = (entry: CatalogAction, input: Readonly<Record<string, unknown>>): ToolResult | undefined => {
    const problems = inputProblems(entry.inputSchema, input, 'input');
    return problems === undefined
      ? undefined
      : errorResult(MSG_INVALID_INPUT(entry.id, problems), { 'ontos/code': 'invalid_input' });
  };

  const proposeBatch = async (
    instruction: string,
    items: readonly ProposeItem[],
    runId: string,
  ): Promise<ToolResult> => {
    const proposals = items.map(
      (item): ProposalInput => {
        const fields = withoutRevision(item.input);
        const { entry } = item;
        return {
          actionSlug: entry.actionSlug,
          appId: entry.appId,
          command: entry.commandTag === undefined ? fields : { ...fields, _tag: entry.commandTag },
          diff: [],
          reason: item.reason,
          risk: annotationsFor(entry).destructiveHint === true ? 'high' : 'medium',
          summary: item.summary.slice(0, 300),
          targetLabel: item.targetLabel.slice(0, 300),
        };
      },
    );
    try {
      const response = await submitProposals(target, {
        agentLabel: `${d.acting.displayName} přes ${d.client.name}`.slice(0, 300),
        instruction: instruction.slice(0, 4000),
        legalEntityId: d.legalEntityId,
        proposals,
        runId,
      });
      const batchUrl = `${deps.config.shellPublicUrl}${response.reviewPath}?davka=${encodeURIComponent(response.batchId)}`;
      return okResult(
        {
          batchId: response.batchId,
          messageCs: MSG_PROPOSED,
          proposalId: response.proposalIds[0],
          proposalIds: response.proposalIds,
          replayed: response.replayed,
          reviewUrl: batchUrl,
          status: 'proposed',
        },
        [reviewLink(batchUrl)],
      );
    } catch (error) {
      const [only] = items;
      if (error instanceof ProposalsEndpointMissingError && items.length === 1 && only !== undefined) {
        // Design §6 fallback: the module's own AiProposeChanges (or the platform queue when it exists).
        return okResult(
          {
            ...(await runExecute(connection.session, catalog, 'approval', {
              id: only.entry.id,
              idempotencyKey: runId,
              input: toJsonObject(only.input),
              reason: only.reason,
            })),
            reviewUrl,
          },
          [reviewLink(reviewUrl)],
        );
      }
      throw error;
    }
  };

  const executeOne = async (
    id: string,
    input: Readonly<Record<string, unknown>> | undefined,
    reason: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<ToolResult> => {
    const checked = writeTargetOf(id);
    if (!('entry' in checked)) {
      return checked.error;
    }
    const { entry } = checked;
    const payload = input ?? {};
    const invalid = checkActionInput(entry, payload);
    if (invalid !== undefined) {
      return invalid;
    }
    const key = idempotencyKey ?? randomUUID();
    const title = entryTitleCs(entry, labelOf(entry.moduleId));
    if (d.writePolicy === 'direct') {
      const hash = requestHash(entry.id, payload);
      if (idempotencyKey !== undefined) {
        const replay = directReplays.lookup(d.grantId, idempotencyKey, hash);
        if (replay.kind === 'hit') {
          return okResult({ ...replay.result, replayed: true });
        }
        if (replay.kind === 'conflict') {
          return errorResult(MSG_IDEMPOTENCY_CONFLICT, { 'ontos/code': 'idempotency_key_reused' });
        }
      }
      const outcome = await runExecute(connection.session, catalog, 'direct', {
        id: entry.id,
        idempotencyKey: key,
        input: toJsonObject(payload),
        reason,
      });
      const link = moduleLink(entry.moduleId);
      const value: Record<string, unknown> = {
        ...outcome,
        messageCs: MSG_EXECUTED,
        replayed: false,
        ...(link?.type === 'resource_link' ? { url: link.uri } : {}),
      };
      if (idempotencyKey !== undefined) {
        directReplays.remember(d.grantId, idempotencyKey, hash, value);
      }
      return okResult(value, link === undefined ? [] : [link]);
    }
    const trimmed = (reason ?? '').trim();
    const reasonText = trimmed.length >= 3 ? trimmed : `Změna navržená přes ${d.client.name}`;
    // The approvals contract rejects empty strings (ShortText/LongText minLength 1).
    return proposeBatch(
      trimmed === '' ? title : trimmed,
      [{ entry, input: payload, reason: reasonText, summary: title, targetLabel: title }],
      key,
    );
  };

  const capabilities = (args: Readonly<Record<string, unknown>>): ToolResult => {
    const id = stringArg(args, 'id');
    if (id !== undefined) {
      const entry = findEntry(catalog, id);
      if (entry === undefined || (entry.kind === 'action' && !isOffered(entry, 'approval', d.acting.kind) && !isOffered(entry, d.writePolicy, d.acting.kind))) {
        return errorResult(MSG_UNKNOWN(id));
      }
      if (!canRead(d, entry.moduleId)) {
        return errorResult(MSG_NO_READ(labelOf(entry.moduleId)));
      }
      const moduleCs = labelOf(entry.moduleId);
      const writable = entry.kind === 'action' && canWrite(d, entry.moduleId) && isOffered(entry, d.writePolicy, d.acting.kind);
      return okResult({
        descriptionCs: entryDescriptionCs(entry, moduleCs, d.writePolicy),
        id: entry.id,
        inputSchema: entry.inputSchema,
        kind: entry.kind,
        moduleCs,
        moduleId: entry.moduleId,
        titleCs: entryTitleCs(entry, moduleCs),
        toolName: entry.toolName,
        ...(entry.kind === 'action'
          ? {
              destructive: annotationsFor(entry).destructiveHint === true,
              proposable: canPropose(d, entry.moduleId),
              writable,
            }
          : {}),
      });
    }
    const tokens = queryTokens(stringArg(args, 'query') ?? '');
    const moduleFilter = stringArg(args, 'moduleId');
    const modules = catalog.modules
      .filter((module) => canRead(d, module.moduleId) && (moduleFilter === undefined || module.moduleId === moduleFilter))
      .flatMap((module) => {
        const moduleCs = labelOf(module.moduleId);
        const moduleText = `${module.moduleId} ${moduleCs} ${moduleDescriptionCs(module.moduleId)} ${moduleKeywordsCs(module.moduleId)}`;
        const write = canWrite(d, module.moduleId);
        const moduleHit = tokens.length > 0 && matchesTokens(tokens, moduleText);
        const matches = (row: { readonly id: string; readonly titleCs: string }): boolean =>
          moduleHit || matchesTokens(tokens, `${row.id} ${row.titleCs} ${moduleText}`);
        const reads = module.reads
          .map((read) => ({ id: read.id, titleCs: entryTitleCs(read, moduleCs) }))
          .filter(matches)
          .slice(0, 60);
        const actions = write
          ? module.actions
              .filter((action) => isOffered(action, d.writePolicy, d.acting.kind))
              .map((action) => ({
                destructive: annotationsFor(action).destructiveHint === true,
                id: action.id,
                titleCs: entryTitleCs(action, moduleCs),
              }))
              .filter(matches)
              .slice(0, 60)
          : [];
        if (tokens.length > 0 && reads.length === 0 && actions.length === 0) {
          return [];
        }
        const writeNoteCs =
          !write && grantAllowsWrite(d, module.moduleId) && d.writePolicy === 'approval' && !acceptsProposals(module.moduleId)
            ? 'Návrhy ke schválení tento modul zatím nepřijímá; změny jen přímo v OntOS.'
            : undefined;
        return [
          {
            actions,
            descriptionCs: moduleDescriptionCs(module.moduleId),
            moduleId: module.moduleId,
            moduleCs,
            reads,
            write,
            ...(writeNoteCs === undefined ? {} : { writeNoteCs }),
          },
        ];
      });
    return okResult({
      hint: 'Čtení: ontos_read {id, input}. Zápis: ontos_execute {id, input, reason}. Vstupní schéma: ontos_capabilities {id}.',
      modules,
      writePolicy: d.writePolicy,
      writePolicyCs: WRITE_POLICY_CS[d.writePolicy],
    });
  };

  const genericSpecs: Partial<Record<GenericToolName, ToolSpec>> = {
    ontos_capabilities: instrument(
      'ontos_capabilities',
      'Co smím v OntOS',
      'Najde čtení a akce, které toto připojení smí použít, podle textu (query, bez ohledu na diakritiku) nebo modulu (moduleId); s parametrem id vrátí popis a vstupní schéma jedné položky. / Search what this connection may read or change; pass id for the input schema.',
      {
        additionalProperties: false,
        properties: {
          id: { maxLength: 300, type: 'string' },
          moduleId: { maxLength: 120, type: 'string' },
          query: {
            description: 'Hledaný text, např. „zákazník“, „úkol“, „faktura“, „smlouva“, „údržba“.',
            maxLength: 200,
            type: 'string',
          },
        },
        type: 'object',
      },
      { openWorldHint: false, readOnlyHint: true },
      async (args) => capabilities(args),
      CAPABILITIES_OUTPUT,
    ),
    ontos_list_proposals: instrument(
      'ontos_list_proposals',
      'Moje návrhy ke schválení',
      'Stav návrhů změn, které toto připojení odeslalo ke schválení. / Status of proposals sent by this connection.',
      { additionalProperties: false, properties: {}, type: 'object' },
      { openWorldHint: false, readOnlyHint: true },
      async () => {
        try {
          const queue = await listProposals(target, d.legalEntityId);
          return okResult({
            batches: queue.batches.slice(0, 20).map((batch) => ({
              batchId: batch.batchId,
              createdAt: batch.createdAt,
              instruction: batch.instruction,
              items: batch.items,
              reviewUrl: `${reviewUrl}?davka=${encodeURIComponent(batch.batchId)}`,
            })),
            pendingCount: queue.pendingCount,
            reviewUrl,
          });
        } catch (error) {
          if (error instanceof ProposalsEndpointMissingError) {
            return errorResult('Fronta návrhů zatím není dostupná.');
          }
          throw error;
        }
      },
      PROPOSALS_OUTPUT,
    ),
    ontos_read: instrument(
      'ontos_read',
      'Načíst data',
      'Načte data z čtení (governed read), ke kterému má připojení přístup. Odpověď je vždy krátká: seznamy se stránkují (limit, offset) a velké části se vynechají (omitted) – načtete je přes path, např. "agendas.assets.state.assets". / Read data through a governed read; page with limit/offset, drill into omitted parts with path.',
      {
        additionalProperties: false,
        properties: {
          id: { maxLength: 300, minLength: 1, type: 'string' },
          input: { additionalProperties: true, type: 'object' },
          limit: { description: 'Počet položek seznamu (výchozí 25).', maximum: 500, minimum: 1, type: 'integer' },
          offset: { description: 'Od které položky seznamu.', minimum: 0, type: 'integer' },
          path: {
            description: 'Jen tato část výsledku, např. „agendas.meters.state.meters“ nebo „items[3]“ (cesty vrací omitted).',
            maxLength: 300,
            type: 'string',
          },
        },
        required: ['id'],
        type: 'object',
      },
      { openWorldHint: false, readOnlyHint: true },
      (args) => {
        const path = stringArg(args, 'path');
        const limit = intArg(args, 'limit');
        const offset = intArg(args, 'offset');
        return runReadTool(stringArg(args, 'id') ?? '', objectArg(args, 'input'), {
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
          ...(path === undefined ? {} : { path }),
        });
      },
      READ_OUTPUT,
    ),
    ontos_whoami: instrument(
      'ontos_whoami',
      'Kdo jsem (profil připojení)',
      'Profil tohoto připojení: firma, za koho aplikace jedná, moduly a režim zápisu. Vrací profile_id. Zavolej jako první. / Connection profile (profile_id, company, acting identity, modules, write mode); call it first.',
      { additionalProperties: false, properties: {}, type: 'object' },
      { openWorldHint: false, readOnlyHint: true },
      async () =>
        okResult({
          acting: d.acting,
          client: { host: d.client.host, kind: d.client.kind, name: d.client.name },
          company: { legalEntityId: d.legalEntityId, legalName: d.legalName },
          delegatedBy: d.delegatedBy,
          // write = what this connection can really change (approval mode: only modules the review queue accepts).
          modules: d.modules.map((module) => {
            const write = canWrite(d, module.moduleId);
            return {
              ...module,
              write,
              ...(!write && grantAllowsWrite(d, module.moduleId)
                ? { writeNoteCs: 'Návrhy ke schválení tento modul zatím nepřijímá; změny jen přímo v OntOS.' }
                : {}),
            };
          }),
          profile_id: d.profileId,
          reviewUrl,
          typedTools: { count: plan.typed.length, overCap: plan.typedOverCap },
          writePolicy: d.writePolicy,
          writePolicyCs: WRITE_POLICY_CS[d.writePolicy],
        }),
      WHOAMI_OUTPUT,
    ),
    ontos_execute: instrument(
      'ontos_execute',
      d.writePolicy === 'direct' ? 'Provést změnu' : 'Navrhnout změnu ke schválení',
      d.writePolicy === 'direct'
        ? 'Provede akci (zápis) v OntOS přes governed Action; server ověří oprávnění a zapíše deník. id z ontos_capabilities. Se stejným idempotencyKey se změna neprovede dvakrát. / Runs a governed Action.'
        : 'Uloží změnu jako NÁVRH, který schválí člověk v OntOS (Nastavení › Ke schválení); data se hned nezmění. Vrací proposalId a reviewUrl. / Submits a proposal a person approves.',
      {
        additionalProperties: false,
        properties: {
          id: { maxLength: 300, minLength: 1, type: 'string' },
          idempotencyKey: { maxLength: 200, minLength: 1, type: 'string' },
          input: { additionalProperties: true, type: 'object' },
          reason: {
            description: 'Proč změnu děláš (uvidí schvalovatel).',
            maxLength: 2000,
            type: 'string',
          },
        },
        required: ['id'],
        type: 'object',
      },
      {
        destructiveHint: d.writePolicy === 'direct',
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      (args) =>
        executeOne(
          stringArg(args, 'id') ?? '',
          objectArg(args, 'input'),
          stringArg(args, 'reason'),
          stringArg(args, 'idempotencyKey'),
        ),
      WRITE_OUTPUT,
    ),
    ontos_propose: instrument(
      'ontos_propose',
      'Navrhnout více změn najednou',
      'Pošle dávku změn ke schválení člověkem (i když připojení smí zapisovat přímo). / Sends a batch of proposals for human approval.',
      {
        additionalProperties: false,
        properties: {
          changes: {
            items: {
              additionalProperties: false,
              properties: {
                id: { maxLength: 300, minLength: 1, type: 'string' },
                input: { additionalProperties: true, type: 'object' },
                reason: { maxLength: 2000, minLength: 1, type: 'string' },
                summary: { maxLength: 300, type: 'string' },
                targetLabel: { maxLength: 300, type: 'string' },
              },
              required: ['id', 'reason'],
              type: 'object',
            },
            maxItems: 20,
            minItems: 1,
            type: 'array',
          },
          instruction: { maxLength: 4000, minLength: 1, type: 'string' },
        },
        required: ['instruction', 'changes'],
        type: 'object',
      },
      { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
      async (args) => {
        const instruction = stringArg(args, 'instruction') ?? '';
        const changes = args['changes'];
        if (!Array.isArray(changes) || changes.length === 0) {
          return errorResult('Chybí seznam změn (changes).');
        }
        const items: ProposeItem[] = [];
        // Every change is validated first, exactly like ontos_execute; the first problem is returned.
        for (const [index, change] of changes.entries()) {
          if (!isPlainObject(change)) {
            return errorResult('Každá změna musí být objekt.');
          }
          const id = stringArg(change, 'id') ?? '';
          const checked = writeTargetOf(id, 'propose');
          if (!('entry' in checked)) {
            return checked.error;
          }
          const input = objectArg(change, 'input') ?? {};
          const invalid = checkActionInput(checked.entry, input);
          if (invalid !== undefined) {
            return errorResult(`Změna č. ${index + 1}: ${invalid.content[0]?.type === 'text' ? invalid.content[0].text : ''}`, {
              'ontos/code': 'invalid_input',
            });
          }
          const title = entryTitleCs(checked.entry, labelOf(checked.entry.moduleId));
          const reason = (stringArg(change, 'reason') ?? '').trim() || `Změna navržená přes ${d.client.name}`;
          items.push({
            entry: checked.entry,
            input,
            reason,
            summary: stringArg(change, 'summary')?.trim() || title,
            targetLabel: stringArg(change, 'targetLabel')?.trim() || title,
          });
        }
        return proposeBatch(instruction.trim() === '' ? 'Dávka změn' : instruction, items, randomUUID());
      },
      WRITE_OUTPUT,
    ),
  };

  const typedSpecs: ToolSpec[] = plan.typed.map((entry) => {
    const label = labelOf(entry.moduleId);
    const base: JsonSchema =
      entry.inputSchema['type'] === 'object' ? entry.inputSchema : { additionalProperties: true, type: 'object' };
    if (entry.kind === 'read') {
      return instrument(
        entry.toolName,
        entryTitleCs(entry, label),
        `${entryDescriptionCs(entry, label, d.writePolicy)} Dlouhé výsledky zkracuje; celé seznamy a vynechané části vrátí ontos_read {id, path, limit, offset}.`,
        base,
        annotationsFor(entry),
        (args) => runReadTool(entry.id, args),
        READ_OUTPUT,
      );
    }
    const { extras, schema } = typedWriteSchema(base);
    return instrument(
      entry.toolName,
      entryTitleCs(entry, label),
      entryDescriptionCs(entry, label, d.writePolicy),
      schema,
      annotationsFor(entry),
      (args) => {
        const input: Record<string, unknown> = { ...args };
        for (const key of extras) {
          delete input[key];
        }
        return executeOne(
          entry.id,
          input,
          extras.includes('reason') ? stringArg(args, 'reason') : undefined,
          extras.includes('idempotencyKey') ? stringArg(args, 'idempotencyKey') : undefined,
        );
      },
      WRITE_OUTPUT,
    );
  });

  const genericTools: ToolSpec[] = plan.generic.flatMap((name) => {
    const spec = genericSpecs[name];
    return spec === undefined ? [] : [spec];
  });
  return [...genericTools, ...typedSpecs];
};
