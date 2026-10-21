/**
 * Connection tools (lane mcp-mcp-rs): the per-request MCP tool list. Generic ontos_* tools plus typed tools, both
 * filtered by the ConnectionDescription (grant, modules, write policy). Failures are Czech tool results, never throws.
 */
import { randomUUID } from 'node:crypto';
import { Schema } from 'effect';
import type { Catalog, CatalogAction, CatalogEntry, JsonSchema } from '../capabilities/types.ts';
import { entryDescriptionCs, entryTitleCs, moduleDescriptionCs, moduleLabelCs, WRITE_POLICY_CS } from '../catalog/labels-cs.ts';
import { ConnectionInactiveError } from '../oauth/types.ts';
import { OntosRequestError } from '../ontos-client.ts';
import { findEntry, findModule, runExecute, runRead, toJsonObject } from '../operations.ts';
import {
  ProposalsEndpointMissingError,
  listProposals,
  submitProposals,
} from './proposals.ts';
import type { ProposalInput, ProposalsTarget } from './proposals.ts';
import { annotationsFor, canRead, canWrite, isAiMetaCommand, planTools } from './tool-plan.ts';
import type { GenericToolName } from './tool-plan.ts';
import type { ConnectionContext, ToolAnnotationsSpec, ToolDeps, ToolResult, ToolSpec } from './types.ts';

export const MSG_READ_ONLY =
  'Toto připojení smí jen číst. Změnu udělejte přímo v OntOS, nebo aplikaci připojte znovu s jiným režimem zápisu.';
export const MSG_NO_WRITE = (label: string): string => `Toto připojení nesmí měnit modul ${label}.`;
export const MSG_NO_READ = (label: string): string => `Toto připojení nemá přístup k modulu ${label}.`;
export const MSG_UNKNOWN = (id: string): string => `Neznámé id ${id}. Seznam vrací ontos_capabilities.`;
export const MSG_AI_META = 'Tuto akci nelze volat přes MCP.';
export const MSG_PROPOSED = 'Návrh čeká na schválení v OntOS (Správa › Ke schválení). Data se zatím nezměnila.';
export const MSG_EXECUTED = 'Změna je provedena a zapsána do deníku.';

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const okResult = (value: unknown): ToolResult => ({
  content: [{ text: JSON.stringify(value), type: 'text' }],
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
    const detail = error.detail ?? error.title ?? 'bez podrobností';
    if (error.status === 403) {
      const code = error.code === undefined ? '' : ` (kód ${error.code})`;
      return errorResult(`OntOS tuto operaci tomuto připojení nepovolil: ${detail}${code}.`);
    }
    const code = error.code === undefined ? '' : ` (${error.code})`;
    return errorResult(`OntOS odpověděl chybou HTTP ${error.status}${code}: ${detail}`);
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

  const instrument = (
    name: string,
    title: string,
    description: string,
    inputSchema: JsonSchema,
    annotations: ToolAnnotationsSpec,
    run: (args: Readonly<Record<string, unknown>>) => Promise<ToolResult>,
  ): ToolSpec => ({
    annotations,
    description,
    handler: async (args) => {
      const started = Date.now();
      let result: ToolResult;
      try {
        result = await run(args);
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
    title,
  });

  const runReadTool = async (
    id: string,
    input: Readonly<Record<string, unknown>> | undefined,
    limit?: number,
    offset?: number,
  ): Promise<ToolResult> => {
    const entry = findEntry(catalog, id);
    const moduleId = moduleIdOf(id, entry);
    if (!canRead(d, moduleId)) {
      return errorResult(MSG_NO_READ(labelOf(moduleId)));
    }
    if (entry === undefined || entry.kind !== 'read') {
      return errorResult(MSG_UNKNOWN(id));
    }
    return okResult(
      await runRead(connection.session, catalog, {
        id: entry.id,
        input: toJsonObject(input ?? {}),
        limit,
        offset,
      }),
    );
  };

  const writeTargetOf = (id: string): WriteTarget => {
    if (d.writePolicy === 'read_only') {
      return { error: errorResult(MSG_READ_ONLY) };
    }
    const entry = findEntry(catalog, id);
    const moduleId = moduleIdOf(id, entry);
    // Before the unknown-id check: writes outside the grant always say "nesmí měnit".
    if (!canWrite(d, moduleId)) {
      return { error: errorResult(MSG_NO_WRITE(labelOf(moduleId))) };
    }
    if (entry === undefined || entry.kind !== 'action') {
      return { error: errorResult(MSG_UNKNOWN(id)) };
    }
    if (isAiMetaCommand(entry)) {
      return { error: errorResult(MSG_AI_META) };
    }
    return { entry };
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
      return okResult({
        batchId: response.batchId,
        messageCs: MSG_PROPOSED,
        proposalId: response.proposalIds[0],
        proposalIds: response.proposalIds,
        replayed: response.replayed,
        reviewUrl: `${deps.config.shellPublicUrl}${response.reviewPath}`,
        status: 'proposed',
      });
    } catch (error) {
      const [only] = items;
      if (error instanceof ProposalsEndpointMissingError && items.length === 1 && only !== undefined) {
        // Design §6 fallback: the module's own AiProposeChanges (or the platform queue when it exists).
        return okResult({
          ...(await runExecute(connection.session, catalog, 'approval', {
            id: only.entry.id,
            idempotencyKey: runId,
            input: toJsonObject(only.input),
            reason: only.reason,
          })),
          reviewUrl,
        });
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
    const key = idempotencyKey ?? randomUUID();
    const title = entryTitleCs(entry, labelOf(entry.moduleId));
    if (d.writePolicy === 'direct') {
      const outcome = await runExecute(connection.session, catalog, 'direct', {
        id: entry.id,
        idempotencyKey: key,
        input: toJsonObject(payload),
        reason,
      });
      return okResult({ ...outcome, messageCs: MSG_EXECUTED });
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
      if (entry === undefined) {
        return errorResult(MSG_UNKNOWN(id));
      }
      if (!canRead(d, entry.moduleId)) {
        return errorResult(MSG_NO_READ(labelOf(entry.moduleId)));
      }
      const moduleCs = labelOf(entry.moduleId);
      return okResult({
        descriptionCs: entryDescriptionCs(entry, moduleCs, d.writePolicy),
        id: entry.id,
        inputSchema: entry.inputSchema,
        kind: entry.kind,
        moduleCs,
        moduleId: entry.moduleId,
        titleCs: entryTitleCs(entry, moduleCs),
        toolName: entry.toolName,
        writable: entry.kind === 'action' && canWrite(d, entry.moduleId) && !isAiMetaCommand(entry),
      });
    }
    const query = (stringArg(args, 'query') ?? '').trim().toLowerCase();
    const moduleFilter = stringArg(args, 'moduleId');
    const matches = (text: string): boolean => query === '' || text.toLowerCase().includes(query);
    const modules = catalog.modules
      .filter((module) => canRead(d, module.moduleId) && (moduleFilter === undefined || module.moduleId === moduleFilter))
      .flatMap((module) => {
        const moduleCs = labelOf(module.moduleId);
        const write = canWrite(d, module.moduleId);
        const reads = module.reads
          .map((read) => ({ id: read.id, titleCs: entryTitleCs(read, moduleCs) }))
          .filter((row) => matches(`${row.id} ${row.titleCs} ${moduleCs}`))
          .slice(0, 60);
        const actions = write
          ? module.actions
              .filter((action) => !isAiMetaCommand(action))
              .map((action) => ({
                destructive: annotationsFor(action).destructiveHint === true,
                id: action.id,
                titleCs: entryTitleCs(action, moduleCs),
              }))
              .filter((row) => matches(`${row.id} ${row.titleCs} ${moduleCs}`))
              .slice(0, 60)
          : [];
        if (query !== '' && reads.length === 0 && actions.length === 0) {
          return [];
        }
        return [
          {
            actions,
            descriptionCs: moduleDescriptionCs(module.moduleId),
            moduleId: module.moduleId,
            moduleCs,
            reads,
            write,
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
      'Najde čtení a akce, které toto připojení smí použít, podle textu (query) nebo modulu (moduleId); s parametrem id vrátí popis a vstupní schéma jedné položky. / Search what this connection may read or change; pass id for the input schema.',
      {
        additionalProperties: false,
        properties: {
          id: { maxLength: 300, type: 'string' },
          moduleId: { maxLength: 120, type: 'string' },
          query: {
            description: 'Hledaný text, např. „zákazník“, „úkol“, „faktura“.',
            maxLength: 200,
            type: 'string',
          },
        },
        type: 'object',
      },
      { openWorldHint: false, readOnlyHint: true },
      async (args) => capabilities(args),
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
    ),
    ontos_read: instrument(
      'ontos_read',
      'Načíst data',
      'Načte data z čtení (governed read), ke kterému má připojení přístup. Dlouhé seznamy se zkracují (limit, offset). / Read data through a governed read.',
      {
        additionalProperties: false,
        properties: {
          id: { maxLength: 300, minLength: 1, type: 'string' },
          input: { additionalProperties: true, type: 'object' },
          limit: { maximum: 500, minimum: 1, type: 'integer' },
          offset: { minimum: 0, type: 'integer' },
        },
        required: ['id'],
        type: 'object',
      },
      { openWorldHint: false, readOnlyHint: true },
      (args) =>
        runReadTool(stringArg(args, 'id') ?? '', objectArg(args, 'input'), intArg(args, 'limit'), intArg(args, 'offset')),
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
          modules: d.modules,
          profile_id: d.profileId,
          reviewUrl,
          typedTools: { count: plan.typed.length, overCap: plan.typedOverCap },
          writePolicy: d.writePolicy,
          writePolicyCs: WRITE_POLICY_CS[d.writePolicy],
        }),
    ),
    ontos_execute: instrument(
      'ontos_execute',
      d.writePolicy === 'direct' ? 'Provést změnu' : 'Navrhnout změnu ke schválení',
      d.writePolicy === 'direct'
        ? 'Provede akci (zápis) v OntOS přes governed Action; server ověří oprávnění a zapíše deník. id z ontos_capabilities. / Runs a governed Action.'
        : 'Uloží změnu jako NÁVRH, který schválí člověk v OntOS (Správa › Ke schválení); data se hned nezmění. Vrací proposalId a reviewUrl. / Submits a proposal a person approves.',
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
        for (const change of changes) {
          if (!isPlainObject(change)) {
            return errorResult('Každá změna musí být objekt.');
          }
          const id = stringArg(change, 'id') ?? '';
          const checked = writeTargetOf(id);
          if (!('entry' in checked)) {
            return checked.error;
          }
          const title = entryTitleCs(checked.entry, labelOf(checked.entry.moduleId));
          const reason = (stringArg(change, 'reason') ?? '').trim() || `Změna navržená přes ${d.client.name}`;
          items.push({
            entry: checked.entry,
            input: objectArg(change, 'input') ?? {},
            reason,
            summary: stringArg(change, 'summary')?.trim() || title,
            targetLabel: stringArg(change, 'targetLabel')?.trim() || title,
          });
        }
        return proposeBatch(instruction.trim() === '' ? 'Dávka změn' : instruction, items, randomUUID());
      },
    ),
  };

  const typedSpecs: ToolSpec[] = plan.typed.map((entry) => {
    const label = labelOf(entry.moduleId);
    const schema: JsonSchema =
      entry.inputSchema['type'] === 'object' ? entry.inputSchema : { additionalProperties: true, type: 'object' };
    return instrument(
      entry.toolName,
      entryTitleCs(entry, label),
      entryDescriptionCs(entry, label, d.writePolicy),
      schema,
      annotationsFor(entry),
      (args) =>
        entry.kind === 'read' ? runReadTool(entry.id, args) : executeOne(entry.id, args, undefined, undefined),
    );
  });

  const genericTools: ToolSpec[] = plan.generic.flatMap((name) => {
    const spec = genericSpecs[name];
    return spec === undefined ? [] : [spec];
  });
  return [...genericTools, ...typedSpecs];
};
