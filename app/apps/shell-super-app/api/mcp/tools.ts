/**
 * The per-request MCP tool list: generic `ontos_*` tools plus the typed tools the composition's verticals contribute,
 * filtered by the connection (live rights ∩ grant ∩ write policy). Failures are Czech tool results, never throws.
 * Writes under the `approval` policy never change data: they go to the platform approval queue („Ke schválení“).
 */
import { agentCommandOf } from '@app/shared-contracts/agent-proposals';
import type { AgentProposalInput } from '@app/shared-contracts/agent-proposals';
import { Duration, Effect, Result } from 'effect';

import type { JsonObject, McpCatalogModule, McpCatalogTool } from './catalog.ts';
import { findModule, findTool } from './catalog.ts';
import { czechProblem } from './errors-cs.ts';
import { inputProblems } from './input-check.ts';
import { CAPABILITIES_OUTPUT, PROPOSALS_OUTPUT, READ_OUTPUT, WHOAMI_OUTPUT, WRITE_OUTPUT } from './output-schemas.ts';
import { DEFAULT_READ_LIMIT, selectPath, shapeReadResult } from './read-shaping.ts';
import type { ReadPathError } from './read-shaping.ts';
import { directReplays, requestHash } from './replay.ts';
import { matchesTokens, queryTokens } from './search.ts';
import { annotationsFor, canPropose, canRead, canWrite, grantAllowsWrite, isOffered, planTools } from './tool-plan.ts';
import type { GenericToolName } from './tool-plan.ts';
import type { McpToolContext, ToolAnnotationsSpec, ToolContent, ToolResult, ToolSpec } from './types.ts';
import { ModuleProblem, ModuleUnavailable } from './types.ts';
import type { ProposalRefused } from './types.ts';

export const WRITE_POLICY_CS = {
  approval: 'zápis jen přes schválení – každá změna čeká na rozhodnutí člověka v aplikaci',
  direct: 'zápis přímo přes Actions (server ověří oprávnění a zapíše audit)',
  read_only: 'jen čtení – toto připojení nic nemění',
} as const;

export const MSG_READ_ONLY =
  'Toto připojení smí jen číst. Změnu udělejte přímo v OntOS, nebo aplikaci připojte znovu s jiným režimem zápisu.';
export const MSG_NO_WRITE = (label: string): string => `Toto připojení nesmí měnit modul ${label}.`;
export const MSG_NO_READ = (label: string): string => `Toto připojení nemá přístup k modulu ${label}.`;
export const MSG_UNKNOWN = (id: string): string => `Neznámé id ${id}. Seznam vrací ontos_capabilities.`;
export const MSG_HUMAN_ONLY =
  'Tuto změnu smí v modulu udělat jen člověk přímo v OntOS. Připojená aplikace ji může jen navrhnout ke schválení (ontos_propose).';
export const MSG_NO_PROPOSALS = (label: string): string =>
  `Modul ${label} nepřijímá návrhy ke schválení, takže ho toto připojení měnit nemůže. Změnu udělejte přímo v OntOS.`;
export const MSG_NO_LIVE_RIGHT = (label: string): string =>
  `Tuto změnu v modulu ${label} teď nemůžete provést (chybí oprávnění v OntOS). Můžete ji navrhnout ke schválení (ontos_propose).`;
export const MSG_INVALID_INPUT = (id: string, problems: string): string =>
  `Vstup pro ${id} neodpovídá schématu: ${problems}. Správné schéma vrátí ontos_capabilities {id: "${id}"}.`;
export const MSG_IDEMPOTENCY_CONFLICT =
  'Stejný klíč idempotencyKey už byl použit pro jinou změnu. Pro novou změnu pošlete nový klíč (nebo ho vynechte).';
export const MSG_PROPOSED = 'Návrh čeká na schválení v OntOS (Nastavení › Ke schválení). Data se zatím nezměnila.';
export const MSG_EXECUTED = 'Změna je provedena a zapsána do deníku.';
const MSG_NO_REVISION = (label: string): string =>
  `Modul ${label} neuvádí revizi záznamů. Pošlete input.expectedRevision (najdete ji ve výsledku ontos_read).`;
const READ_NOTE_CS =
  'Výsledek je zkrácený. Další položky seznamu: stejné volání s offset. Vynechané části (omitted) načtěte přes ontos_read {id, path}.';
const NOT_PROPOSABLE_NOTE = 'Návrhy ke schválení tento modul nepřijímá; změny jen přímo v OntOS.';

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const okResult = (value: unknown, links: readonly ToolContent[] = []): ToolResult => ({
  content: [{ text: JSON.stringify(value), type: 'text' }, ...links],
  structuredContent: isPlainObject(value) ? value : { value },
});

export const errorResult = (message: string, meta?: Readonly<Record<string, unknown>>): ToolResult => ({
  content: [{ text: message, type: 'text' }],
  isError: true,
  ...(meta === undefined ? {} : { _meta: meta }),
});

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

const problemOf = (status: number, body: unknown): ModuleProblem => {
  const field = (key: string): string | undefined => {
    const value = isPlainObject(body) ? body[key] : undefined;
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  return new ModuleProblem({ code: field('code'), detail: field('detail'), status, title: field('title') });
};

/** Everything a tool can fail with; each becomes an `isError` tool result. */
type ToolFailure = ModuleProblem | ModuleUnavailable | ProposalRefused | ReadPathError;

type ToolRun = (args: Readonly<Record<string, unknown>>) => Effect.Effect<ToolResult, ToolFailure>;

/** Optional fields every typed write tool gets besides the Action input (only when the input has no such field). */
const TYPED_WRITE_EXTRAS: Readonly<Record<string, JsonObject>> = {
  idempotencyKey: {
    description: 'Stejný klíč při opakování vrátí původní výsledek a nic nezmění dvakrát.',
    maxLength: 200,
    minLength: 1,
    type: 'string',
  },
  reason: { description: 'Proč změnu děláš (uvidí schvalovatel).', maxLength: 2000, type: 'string' },
};

const typedWriteSchema = (schema: JsonObject): { readonly extras: readonly string[]; readonly schema: JsonObject } => {
  const properties = isPlainObject(schema['properties']) ? (schema['properties'] as JsonObject) : {};
  const extras = Object.keys(TYPED_WRITE_EXTRAS).filter((key) => !Object.hasOwn(properties, key));
  return extras.length === 0
    ? { extras, schema }
    : {
        extras,
        schema: {
          ...schema,
          properties: {
            ...properties,
            ...Object.fromEntries(extras.map((key) => [key, TYPED_WRITE_EXTRAS[key] ?? {}])),
          },
        },
      };
};

interface ProposeItem {
  readonly input: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly summary: string;
  readonly targetLabel: string;
  readonly tool: McpCatalogTool;
}

type WriteTarget = { readonly error: ToolResult } | { readonly tool: McpCatalogTool };

const actionSlugOf = (tool: McpCatalogTool): string => tool.invoke.path.split('/').at(-1) ?? '';

const withoutRevision = (input: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const { expectedRevision: _revision, ...fields } = input;
  return fields;
};

/** The command a write tool sends (`_tag` added for command-union tools), without `expectedRevision`. */
const commandOf = (tool: McpCatalogTool, input: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const fields = withoutRevision(input);
  return tool.invoke.commandTag === undefined ? fields : { ...fields, _tag: tool.invoke.commandTag };
};

export const buildConnectionTools = (context: McpToolContext): readonly ToolSpec[] => {
  const { backend, catalog, description: d } = context;
  const plan = planTools(catalog, d);
  const moduleOf = (moduleId: string): McpCatalogModule | undefined => findModule(catalog, moduleId);
  const labelOf = (moduleId: string): string =>
    moduleOf(moduleId)?.label.cs ?? d.modules.find((module) => module.moduleId === moduleId)?.label ?? moduleId;
  const moduleIdOf = (id: string, tool: McpCatalogTool | undefined): string => tool?.moduleId ?? id.split('/')[0] ?? '';
  const reviewUrl = `${context.publicOrigin}/cs/sprava/ke-schvaleni`;
  const reviewLink = (url: string): ToolContent => ({
    description: 'Návrh schválí nebo zamítne člověk v OntOS.',
    mimeType: 'text/html',
    name: 'ke-schvaleni',
    title: 'OntOS › Ke schválení',
    type: 'resource_link',
    uri: url,
  });
  const moduleLink = (moduleId: string): ToolContent | undefined => {
    const page = moduleOf(moduleId)?.page;
    return page === undefined
      ? undefined
      : {
          mimeType: 'text/html',
          name: moduleId,
          title: `OntOS › ${labelOf(moduleId)}`,
          type: 'resource_link',
          uri: `${context.publicOrigin}/cs${page}`,
        };
  };
  const titleOf = (tool: McpCatalogTool): string => tool.title.cs;
  const descriptionOf = (tool: McpCatalogTool): string => {
    const label = labelOf(tool.moduleId);
    const extra = tool.description === undefined ? '' : ` ${tool.description.cs}`;
    const english = ` / ${tool.title.en}.`;
    if (tool.access === 'read') {
      return `${tool.title.cs} (${label}).${extra} Čtení přes governed read; vrací jen data, která tento účet smí vidět. Id: ${tool.id}.${english}`;
    }
    if (d.writePolicy === 'approval') {
      return `${tool.title.cs} (${label}).${extra} Pouze NÁVRH: data se nezmění, změnu schválí nebo zamítne člověk v aplikaci. Id: ${tool.id}.${english}`;
    }
    return `${tool.title.cs} (${label}).${extra} Zápis přes governed Action: server ověří oprávnění a zapíše audit. Id: ${tool.id}.${english}`;
  };

  const toolError = (error: ToolFailure): ToolResult => {
    if (error._tag !== 'ModuleProblem') {
      return errorResult(error.message);
    }
    if (error.status === 401) {
      return errorResult('Připojení k OntOS už neplatí. Připojte aplikaci znovu.', {
        'mcp/www_authenticate': [`Bearer resource_metadata="${context.prmUrl}", scope="ontos", error="invalid_token"`],
      });
    }
    const problem = czechProblem(error);
    return errorResult(problem.text, problem.meta);
  };
  const newId = context.crypto.randomUUIDv4.pipe(Effect.orDie);

  const instrument = (
    name: string,
    title: string,
    toolDescription: string,
    inputSchema: JsonObject,
    annotations: ToolAnnotationsSpec,
    run: ToolRun,
    outputSchema?: JsonObject,
  ): ToolSpec => ({
    annotations,
    description: toolDescription,
    handler: (args) =>
      Effect.suspend(() => {
        const problems = inputProblems(inputSchema, args);
        return problems === undefined
          ? run(args)
          : Effect.succeed(
              errorResult(`Neplatné argumenty nástroje ${name}: ${problems}.`, { 'ontos/code': 'invalid_arguments' }),
            );
      }).pipe(
        Effect.catch((error) => Effect.succeed(toolError(error))),
        // A tool never fails the MCP call: a defect becomes an error result like any other failure.
        Effect.catchDefect((defect) =>
          Effect.succeed(errorResult(defect instanceof Error ? defect.message : String(defect))),
        ),
        Effect.timed,
        Effect.tap(([elapsed, result]) =>
          Effect.logInfo('mcp.tool').pipe(
            Effect.annotateLogs({
              grantId: d.grantId,
              ms: Duration.toMillis(elapsed),
              outcome: result.isError === true ? 'error' : 'ok',
              tool: name,
            }),
          ),
        ),
        Effect.map(([, result]) => result),
      ),
    inputSchema,
    name,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    title,
  });

  const call = (
    tool: McpCatalogTool,
    path: string,
    body: unknown,
    options: { readonly idempotencyKey?: string; readonly referenceAudiences?: readonly string[] } = {},
  ): Effect.Effect<unknown, ModuleProblem | ModuleUnavailable> =>
    backend
      .callModule(tool.appId, path, body, options)
      .pipe(
        Effect.flatMap((answer) =>
          answer.status < 200 || answer.status >= 300
            ? Effect.fail(problemOf(answer.status, answer.body))
            : Effect.succeed(answer.body),
        ),
      );

  const runRead = (
    tool: McpCatalogTool,
    input: Readonly<Record<string, unknown>>,
    options: { readonly limit?: number; readonly offset?: number; readonly path?: string },
  ) =>
    Effect.gen(function* runReadEffect() {
      const limit = Math.min(Math.max(options.limit ?? DEFAULT_READ_LIMIT, 1), 500);
      const offset = Math.max(options.offset ?? 0, 0);
      const data = yield* call(tool, tool.invoke.path, input);
      const path = options.path?.trim() ?? '';
      const selected = path === '' ? data : yield* Effect.fromResult(selectPath(data, path));
      const shaped = shapeReadResult(selected, { basePath: path, limit, offset });
      return {
        data: shaped.data,
        id: tool.id,
        legalEntityId: d.legalEntityId,
        omitted: shaped.omitted,
        ...(path === '' ? {} : { path }),
        truncated: shaped.truncated,
      };
    });

  const runReadTool = (
    id: string,
    input: Readonly<Record<string, unknown>> | undefined,
    options: { readonly limit?: number; readonly offset?: number; readonly path?: string } = {},
  ): Effect.Effect<ToolResult, ToolFailure> => {
    const tool = findTool(catalog, id);
    const moduleId = moduleIdOf(id, tool);
    if (!canRead(d, moduleId)) {
      return Effect.succeed(errorResult(MSG_NO_READ(labelOf(moduleId))));
    }
    if (tool === undefined || tool.access !== 'read') {
      return Effect.succeed(errorResult(MSG_UNKNOWN(id)));
    }
    const problems = inputProblems(tool.inputSchema, input ?? {}, 'input');
    if (problems !== undefined) {
      return Effect.succeed(errorResult(MSG_INVALID_INPUT(tool.id, problems), { 'ontos/code': 'invalid_input' }));
    }
    return runRead(tool, input ?? {}, options).pipe(
      Effect.map((read) =>
        okResult(read.truncated.length > 0 || read.omitted.length > 0 ? { ...read, noteCs: READ_NOTE_CS } : read),
      ),
    );
  };

  /** The answer of the module's revision read (also carries live right flags such as `canWrite`). */
  const revisionAnswer = (module: McpCatalogModule, tool: McpCatalogTool) =>
    module.revision === undefined ? Effect.void : call(tool, module.revision.path, module.revision.query);

  const revisionFrom = (module: McpCatalogModule, answer: unknown, tag: string | undefined): number | undefined => {
    const revision = module.revision;
    if (revision === undefined) {
      return undefined;
    }
    const field =
      revision.fieldsByCommandPrefix.find((entry) => tag !== undefined && tag.startsWith(entry.prefix))?.field ??
      revision.field;
    return Result.match(selectPath(answer, field), {
      onFailure: () => undefined,
      onSuccess: (value) => (typeof value === 'number' ? value : undefined),
    });
  };

  const executeDirect = (
    tool: McpCatalogTool,
    input: Readonly<Record<string, unknown>>,
    key: string,
    snapshot: unknown,
  ): Effect.Effect<unknown, ModuleProblem | ModuleUnavailable> => {
    const module = moduleOf(tool.moduleId);
    const options = { referenceAudiences: tool.referenceAudiences };
    if (tool.invoke.commandTag === undefined || module === undefined) {
      return call(tool, tool.invoke.path, input, { ...options, idempotencyKey: key });
    }
    const command = commandOf(tool, input);
    const revisionOf = (answer: unknown): Effect.Effect<number, ModuleUnavailable> => {
      const revision = revisionFrom(module, answer, tool.invoke.commandTag);
      return revision === undefined
        ? Effect.fail(new ModuleUnavailable({ message: MSG_NO_REVISION(labelOf(tool.moduleId)) }))
        : Effect.succeed(revision);
    };
    const given = input['expectedRevision'];
    const send = (revision: number, idempotencyKey: string) =>
      call(tool, tool.invoke.path, { command, expectedRevision: revision }, { ...options, idempotencyKey });
    return (typeof given === 'number' ? Effect.succeed(given) : revisionOf(snapshot)).pipe(
      Effect.flatMap((revision) => send(revision, key)),
      Effect.catchIf(
        (error) =>
          error._tag === 'ModuleProblem' && error.status === 409 && (error.code ?? '').endsWith('revision_conflict'),
        // Only a conflict needs a fresh snapshot. Its changed command body needs its own stable key.
        () =>
          revisionAnswer(module, tool).pipe(
            Effect.flatMap(revisionOf),
            Effect.flatMap((revision) => send(revision, `${key}-retry`)),
          ),
      ),
    );
  };

  /** Live flags of a successful revision read: modules need not advertise additional write flags. */
  const snapshotAllowsWrite = (tool: McpCatalogTool, flags: unknown): boolean =>
    !isPlainObject(flags) ||
    (flags['canWrite'] !== false && (tool.liveRight === undefined || flags[tool.liveRight] !== false));

  const liveWriteAllowed = (tool: McpCatalogTool): Effect.Effect<boolean> => {
    const module = moduleOf(tool.moduleId);
    if (module?.revision === undefined) {
      return Effect.succeed(true);
    }
    return revisionAnswer(module, tool).pipe(
      Effect.map((flags) => snapshotAllowsWrite(tool, flags)),
      Effect.orElseSucceed(() => false),
    );
  };

  const writeTargetOf = (id: string, mode: 'propose' | 'write' = 'write'): WriteTarget => {
    if (d.writePolicy === 'read_only') {
      return { error: errorResult(MSG_READ_ONLY) };
    }
    const tool = findTool(catalog, id);
    const moduleId = moduleIdOf(id, tool);
    if (!grantAllowsWrite(d, moduleId)) {
      return { error: errorResult(MSG_NO_WRITE(labelOf(moduleId))) };
    }
    if (tool === undefined || tool.access !== 'write') {
      return { error: errorResult(MSG_UNKNOWN(id)) };
    }
    if (mode === 'write' && !isOffered(tool, d.writePolicy, d.acting.kind)) {
      return { error: errorResult(MSG_HUMAN_ONLY) };
    }
    const module = moduleOf(moduleId);
    const allowed = mode === 'propose' ? canPropose(d, module) : canWrite(d, module);
    return allowed ? { tool } : { error: errorResult(MSG_NO_PROPOSALS(labelOf(moduleId))) };
  };

  const checkActionInput = (tool: McpCatalogTool, input: Readonly<Record<string, unknown>>): ToolResult | undefined => {
    const problems = inputProblems(tool.inputSchema, input, 'input');
    return problems === undefined
      ? undefined
      : errorResult(MSG_INVALID_INPUT(tool.id, problems), { 'ontos/code': 'invalid_input' });
  };

  const proposeBatch = (instruction: string, items: readonly ProposeItem[], runId: string) =>
    Effect.gen(function* proposeBatchEffect() {
      const proposals = items.map((item): AgentProposalInput => ({
        actionSlug: actionSlugOf(item.tool),
        appId: item.tool.appId,
        command: agentCommandOf(commandOf(item.tool, item.input)),
        diff: [],
        reason: item.reason,
        ...(item.tool.referenceAudiences.length === 0 ? {} : { referenceAudiences: item.tool.referenceAudiences }),
        risk: item.tool.destructive ? 'high' : 'medium',
        summary: item.summary.slice(0, 300),
        targetLabel: item.targetLabel.slice(0, 300),
      }));
      const response = yield* backend.submitProposals({
        agentLabel: `${d.acting.displayName} přes ${d.client.name}`.slice(0, 300),
        instruction: instruction.slice(0, 4000),
        legalEntityId: d.legalEntityId,
        proposals,
        runId,
      });
      const batchUrl = `${context.publicOrigin}${response.reviewPath}?davka=${encodeURIComponent(response.batchId)}`;
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
    });

  const executeOne = (
    id: string,
    input: Readonly<Record<string, unknown>> | undefined,
    reason: string | undefined,
    idempotencyKey: string | undefined,
  ): Effect.Effect<ToolResult, ToolFailure> =>
    Effect.gen(function* executeOneEffect() {
      const checked = writeTargetOf(id);
      if ('error' in checked) {
        return checked.error;
      }
      const { tool } = checked;
      const payload = input ?? {};
      const invalid = checkActionInput(tool, payload);
      if (invalid !== undefined) {
        return invalid;
      }
      const key = idempotencyKey ?? (yield* newId);
      if (d.writePolicy === 'direct') {
        const module = moduleOf(tool.moduleId);
        // Reuse this successful read only within this command; the owner Action still authorizes the write.
        const snapshot = module === undefined ? undefined : yield* revisionAnswer(module, tool);
        if (!snapshotAllowsWrite(tool, snapshot)) {
          return errorResult(MSG_NO_LIVE_RIGHT(labelOf(tool.moduleId)));
        }
        const hash = yield* requestHash(context.crypto, tool.id, payload);
        if (idempotencyKey !== undefined) {
          const replay = directReplays.lookup(d.grantId, idempotencyKey, hash);
          if (replay.kind === 'hit') {
            return okResult({ ...replay.result, replayed: true });
          }
          if (replay.kind === 'conflict') {
            return errorResult(MSG_IDEMPOTENCY_CONFLICT, { 'ontos/code': 'idempotency_key_reused' });
          }
        }
        const result = yield* executeDirect(tool, payload, key, snapshot);
        const link = moduleLink(tool.moduleId);
        const value: Record<string, unknown> = {
          messageCs: MSG_EXECUTED,
          replayed: false,
          result,
          status: 'executed',
          ...(link?.type === 'resource_link' ? { url: link.uri } : {}),
        };
        if (idempotencyKey !== undefined) {
          directReplays.remember(d.grantId, idempotencyKey, hash, value);
        }
        return okResult(value, link === undefined ? [] : [link]);
      }
      const trimmed = (reason ?? '').trim();
      const reasonText = trimmed.length >= 3 ? trimmed : `Změna navržená přes ${d.client.name}`;
      const title = titleOf(tool);
      return yield* proposeBatch(
        trimmed === '' ? title : trimmed,
        [{ input: payload, reason: reasonText, summary: title, targetLabel: title, tool }],
        key,
      );
    });

  const capabilities = (args: Readonly<Record<string, unknown>>): Effect.Effect<ToolResult> =>
    Effect.gen(function* capabilitiesEffect() {
      const id = stringArg(args, 'id');
      if (id !== undefined) {
        const tool = findTool(catalog, id);
        if (tool === undefined) {
          return errorResult(MSG_UNKNOWN(id));
        }
        if (!canRead(d, tool.moduleId)) {
          return errorResult(MSG_NO_READ(labelOf(tool.moduleId)));
        }
        const module = moduleOf(tool.moduleId);
        const moduleCs = labelOf(tool.moduleId);
        const writable =
          tool.access === 'write' &&
          canWrite(d, module) &&
          isOffered(tool, d.writePolicy, d.acting.kind) &&
          (d.writePolicy !== 'direct' || (yield* liveWriteAllowed(tool)));
        return okResult({
          descriptionCs: descriptionOf(tool),
          id: tool.id,
          inputSchema: tool.inputSchema,
          kind: tool.access === 'read' ? 'read' : 'action',
          moduleCs,
          moduleId: tool.moduleId,
          titleCs: tool.title.cs,
          titleEn: tool.title.en,
          toolName: tool.name,
          ...(tool.access === 'write'
            ? { destructive: tool.destructive, proposable: canPropose(d, module), writable }
            : {}),
        });
      }
      const tokens = queryTokens(stringArg(args, 'query') ?? '');
      const moduleFilter = stringArg(args, 'moduleId');
      const modules = catalog.modules
        .filter(
          (module) => canRead(d, module.moduleId) && (moduleFilter === undefined || module.moduleId === moduleFilter),
        )
        .flatMap((module) => {
          const moduleCs = labelOf(module.moduleId);
          const moduleText = `${module.moduleId} ${moduleCs} ${module.label.en} ${module.description.cs} ${module.description.en} ${module.keywords}`;
          const write = canWrite(d, module);
          const moduleHit = tokens.length > 0 && matchesTokens(tokens, moduleText);
          const matches = (row: { readonly id: string; readonly titleCs: string; readonly titleEn: string }): boolean =>
            moduleHit || matchesTokens(tokens, `${row.id} ${row.titleCs} ${row.titleEn} ${moduleText}`);
          const reads = module.tools
            .filter((tool) => tool.access === 'read')
            .map((tool) => ({ id: tool.id, titleCs: tool.title.cs, titleEn: tool.title.en }))
            .filter(matches)
            .slice(0, 60);
          const actions = write
            ? module.tools
                .filter((tool) => tool.access === 'write' && isOffered(tool, d.writePolicy, d.acting.kind))
                .map((tool) => ({
                  destructive: tool.destructive,
                  id: tool.id,
                  titleCs: tool.title.cs,
                  titleEn: tool.title.en,
                }))
                .filter(matches)
                .slice(0, 60)
            : [];
          if (tokens.length > 0 && reads.length === 0 && actions.length === 0) {
            return [];
          }
          const writeNoteCs =
            !write && grantAllowsWrite(d, module.moduleId) && d.writePolicy === 'approval' && !module.approvals
              ? NOT_PROPOSABLE_NOTE
              : undefined;
          return [
            {
              actions,
              descriptionCs: module.description.cs,
              moduleCs,
              moduleId: module.moduleId,
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
    });

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
      capabilities,
      CAPABILITIES_OUTPUT,
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
          reason: { description: 'Proč změnu děláš (uvidí schvalovatel).', maxLength: 2000, type: 'string' },
        },
        required: ['id'],
        type: 'object',
      },
      { destructiveHint: d.writePolicy === 'direct', idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      (args) =>
        executeOne(
          stringArg(args, 'id') ?? '',
          objectArg(args, 'input'),
          stringArg(args, 'reason'),
          stringArg(args, 'idempotencyKey'),
        ),
      WRITE_OUTPUT,
    ),
    ontos_list_proposals: instrument(
      'ontos_list_proposals',
      'Moje návrhy ke schválení',
      'Stav návrhů změn, které toto připojení odeslalo ke schválení. / Status of proposals sent by this connection.',
      { additionalProperties: false, properties: {}, type: 'object' },
      { openWorldHint: false, readOnlyHint: true },
      () =>
        backend.listProposals.pipe(
          Effect.map((queue) =>
            okResult({
              batches: queue.batches.slice(0, 20).map((batch) => ({
                batchId: batch.batchId,
                createdAt: batch.createdAt,
                instruction: batch.instruction,
                items: batch.items.map((item) => ({
                  status: item.status,
                  summary: item.summary,
                  targetLabel: item.targetLabel,
                })),
                reviewUrl: `${reviewUrl}?davka=${encodeURIComponent(batch.batchId)}`,
              })),
              pendingCount: queue.pendingCount,
              reviewUrl,
            }),
          ),
        ),
      PROPOSALS_OUTPUT,
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
      (args) =>
        Effect.gen(function* proposeEffect() {
          const instruction = stringArg(args, 'instruction') ?? '';
          const changes = args['changes'];
          if (!Array.isArray(changes) || changes.length === 0) {
            return errorResult('Chybí seznam změn (changes).');
          }
          const items: ProposeItem[] = [];
          for (const [index, change] of changes.entries()) {
            if (!isPlainObject(change)) {
              return errorResult('Každá změna musí být objekt.');
            }
            const checked = writeTargetOf(stringArg(change, 'id') ?? '', 'propose');
            if ('error' in checked) {
              return checked.error;
            }
            const input = objectArg(change, 'input') ?? {};
            const invalid = checkActionInput(checked.tool, input);
            if (invalid !== undefined) {
              const text = invalid.content[0]?.type === 'text' ? invalid.content[0].text : '';
              return errorResult(`Změna č. ${index + 1}: ${text}`, { 'ontos/code': 'invalid_input' });
            }
            const title = titleOf(checked.tool);
            items.push({
              input,
              reason: (stringArg(change, 'reason') ?? '').trim() || `Změna navržená přes ${d.client.name}`,
              summary: stringArg(change, 'summary')?.trim() || title,
              targetLabel: stringArg(change, 'targetLabel')?.trim() || title,
              tool: checked.tool,
            });
          }
          return yield* proposeBatch(instruction.trim() === '' ? 'Dávka změn' : instruction, items, yield* newId);
        }),
      WRITE_OUTPUT,
    ),
    ontos_read: instrument(
      'ontos_read',
      'Načíst data',
      'Načte data z čtení (governed read), ke kterému má připojení přístup. Odpověď je vždy krátká: seznamy se stránkují (limit, offset) a velké části se vynechají (omitted) – načtete je přes path. / Read data through a governed read; page with limit/offset, drill into omitted parts with path.',
      {
        additionalProperties: false,
        properties: {
          id: { maxLength: 300, minLength: 1, type: 'string' },
          input: { additionalProperties: true, type: 'object' },
          limit: { description: 'Počet položek seznamu (výchozí 25).', maximum: 500, minimum: 1, type: 'integer' },
          offset: { description: 'Od které položky seznamu.', minimum: 0, type: 'integer' },
          path: {
            description: 'Jen tato část výsledku, např. „items[3]“ (cesty vrací omitted).',
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
      () =>
        Effect.sync(() =>
          okResult({
            acting: d.acting,
            client: { host: d.client.host, kind: d.client.kind, name: d.client.name },
            company: { legalEntityId: d.legalEntityId, legalName: d.legalName },
            delegatedBy: d.delegatedBy,
            modules: d.modules.map((granted) => {
              const module = moduleOf(granted.moduleId);
              const write = canWrite(d, module);
              return {
                label: labelOf(granted.moduleId),
                moduleId: granted.moduleId,
                read: granted.read,
                tools: module?.tools.length ?? 0,
                write,
                ...(!write && grantAllowsWrite(d, granted.moduleId) ? { writeNoteCs: NOT_PROPOSABLE_NOTE } : {}),
              };
            }),
            profile_id: d.profileId,
            reviewUrl,
            typedTools: { count: plan.typed.length, overCap: plan.typedOverCap },
            writePolicy: d.writePolicy,
            writePolicyCs: WRITE_POLICY_CS[d.writePolicy],
          }),
        ),
      WHOAMI_OUTPUT,
    ),
  };

  const typedSpecs = plan.typed.map((tool) => {
    const base: JsonObject =
      tool.inputSchema['type'] === 'object' ? tool.inputSchema : { additionalProperties: true, type: 'object' };
    if (tool.access === 'read') {
      return instrument(
        tool.name,
        titleOf(tool),
        `${descriptionOf(tool)} Dlouhé výsledky zkracuje; celé seznamy a vynechané části vrátí ontos_read {id, path, limit, offset}.`,
        base,
        annotationsFor(tool),
        (args) => runReadTool(tool.id, args),
        READ_OUTPUT,
      );
    }
    const { extras, schema } = typedWriteSchema(base);
    return instrument(
      tool.name,
      titleOf(tool),
      descriptionOf(tool),
      schema,
      annotationsFor(tool),
      (args) => {
        const input: Record<string, unknown> = { ...args };
        for (const key of extras) {
          delete input[key];
        }
        return executeOne(
          tool.id,
          input,
          extras.includes('reason') ? stringArg(args, 'reason') : undefined,
          extras.includes('idempotencyKey') ? stringArg(args, 'idempotencyKey') : undefined,
        );
      },
      WRITE_OUTPUT,
    );
  });

  const genericTools = plan.generic.flatMap((name) => {
    const spec = genericSpecs[name];
    return spec === undefined ? [] : [spec];
  });
  return [...genericTools, ...typedSpecs];
};
