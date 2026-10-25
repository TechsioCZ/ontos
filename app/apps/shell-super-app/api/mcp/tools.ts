/**
 * The per-request MCP tool list: generic `ontos_*` tools plus the typed tools the composition's verticals contribute,
 * filtered by the connection (live rights ∩ grant ∩ write policy). Expected failures are Czech tool results.
 * Writes under the `approval` policy never change data: they go to the platform approval queue („Ke schválení“).
 */
import { agentCommandOf } from '@app/shared-contracts/agent-proposals';
import type { AgentProposalInput } from '@app/shared-contracts/agent-proposals';
import { Duration, Effect, Option, Predicate, Result, Schema } from 'effect';

import type { JsonObject, McpCatalogModule, McpCatalogTool } from './catalog.ts';
import { findModule, findTool } from './catalog.ts';
import { czechProblem } from './errors-cs.ts';
import { inputProblems } from './input-check.ts';
import { problemOf } from './module-problem.ts';
import type { ModuleProblem } from './module-problem.ts';
import { ModuleUnavailable } from './module-unavailable.ts';
import type { ProposalRefused } from './proposal-refused.ts';
import { CAPABILITIES_OUTPUT, PROPOSALS_OUTPUT, READ_OUTPUT, WHOAMI_OUTPUT, WRITE_OUTPUT } from './output-schemas.ts';
import { DEFAULT_READ_LIMIT, paginateReadResult, selectPath } from './read-shaping.ts';
import type { ReadPathError } from './read-shaping.ts';
import { directReplays, requestHash } from './replay.ts';
import { matchesTokens, queryTokens } from './search.ts';
import { annotationsFor, canPropose, canRead, canWrite, grantAllowsWrite, isOffered, planTools } from './tool-plan.ts';
import type { GenericToolName } from './tool-plan.ts';
import {
  CapabilitiesInput,
  decodeToolInput,
  EmptyInput,
  ExecuteInput,
  InvalidToolArguments,
  ProposeInput,
  ReadInput,
  toolInputSchema,
  TypedWriteIntent,
} from './tool-inputs.ts';
import type { CallerIntentKey } from './tool-inputs.ts';
import type { McpToolContext, ToolAnnotationsSpec, ToolContent, ToolResult, ToolSpec } from './types.ts';

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
  'Stejný klíč idempotencyKey už byl použit pro jinou změnu. Pro novou změnu pošlete nový klíč; při opakování zachovejte původní klíč i vstup.';
export const MSG_PROPOSED = 'Návrh čeká na schválení v OntOS (Nastavení › Ke schválení). Data se zatím nezměnila.';
export const MSG_EXECUTED = 'Změna je provedena a zapsána do deníku.';
const MSG_NO_REVISION = (label: string): string =>
  `Modul ${label} neuvádí revizi záznamů. Pošlete input.expectedRevision (najdete ji ve výsledku ontos_read).`;
const READ_NOTE_CS =
  'Výsledek je zkrácený. Další položky seznamu: stejné volání s offset. Vynechané části (omitted) načtěte přes ontos_read {id, path}.';
const NOT_PROPOSABLE_NOTE = 'Návrhy ke schválení tento modul nepřijímá; změny jen přímo v OntOS.';

const isJsonObject = Schema.is(Schema.JsonObject);
const encodeToolResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

export const okResult = (value: Schema.Json, links: readonly ToolContent[] = []): Effect.Effect<ToolResult> =>
  encodeToolResult(value).pipe(
    Effect.map((text): ToolResult => ({
      content: [{ text, type: 'text' }, ...links],
      structuredContent: isJsonObject(value) ? value : { value },
    })),
    // These are locally constructed JSON results; an encoding failure is a defect, not a module refusal.
    Effect.orDie,
  );

export const errorResult = (message: string, meta?: Schema.JsonObject): ToolResult => {
  const result: ToolResult = { content: [{ text: message, type: 'text' }], isError: true };
  return meta === undefined ? result : { ...result, _meta: meta };
};

/** Expected operation failures become tool results; defects belong to the SDK/HTTP boundary. */
type ToolFailure = InvalidToolArguments | ModuleProblem | ModuleUnavailable | ProposalRefused | ReadPathError;
type ToolRun = (args: Schema.JsonObject) => Effect.Effect<ToolResult, ToolFailure>;

/** The pagination envelope is ours; module data stays opaque JSON inside it. */
const ReadPage = Schema.Struct({
  data: Schema.Json,
  omitted: Schema.Array(
    Schema.Struct({ count: Schema.Finite, kind: Schema.Literals(['list', 'object']), path: Schema.String }),
  ),
  truncated: Schema.Array(
    Schema.Struct({ offset: Schema.Finite, path: Schema.String, returned: Schema.Finite, total: Schema.Finite }),
  ),
});
const ExecutedResult = Schema.Struct({
  messageCs: Schema.String,
  replayed: Schema.Boolean,
  result: Schema.Json,
  status: Schema.Literal('executed'),
  url: Schema.optionalKey(Schema.String),
});

/** Action-owned fields stay untouched. A key collision requires the generic input wrapper. */
const hasIntentCollision = (schema: JsonObject): boolean =>
  isJsonObject(schema['properties']) && Object.hasOwn(schema['properties'], 'idempotencyKey');

// This metadata is generated from our own intent contract before any tool runs.
const TYPED_WRITE_EXTRAS = Schema.decodeUnknownResult(Schema.JsonObject)(
  toolInputSchema(TypedWriteIntent)['properties'],
).pipe(Result.getOrThrow);
const typedWriteSchema = (schema: JsonObject) => {
  const properties = Option.getOrElse(Schema.decodeUnknownOption(Schema.JsonObject)(schema['properties']), () => ({}));
  const additions = Object.entries(TYPED_WRITE_EXTRAS).filter(([key]) => !Object.hasOwn(properties, key));
  const extras = new Set(additions.map(([key]) => key));
  const required = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Array(Schema.String))(schema['required']),
    () => [],
  );
  return {
    extras,
    schema: {
      ...schema,
      properties: { ...properties, ...Object.fromEntries(additions) },
      required: [...required, 'idempotencyKey'],
    },
  };
};

interface ProposeItem {
  readonly input: Schema.JsonObject;
  readonly reason: string;
  readonly summary: string;
  readonly targetLabel: string;
  readonly tool: McpCatalogTool;
}

type WriteTarget = { readonly error: ToolResult } | { readonly tool: McpCatalogTool };

const actionSlugOf = (tool: McpCatalogTool): string => tool.invoke.path.split('/').at(-1) ?? '';

const withoutRevision = (input: Schema.JsonObject): Schema.JsonObject => {
  const { expectedRevision: _revision, ...fields } = input;
  return fields;
};

/** The command a write tool sends (`_tag` added for command-union tools), without `expectedRevision`. */
const commandOf = (tool: McpCatalogTool, input: Schema.JsonObject): Schema.JsonObject => {
  const fields = withoutRevision(input);
  if (tool.invoke.commandTag === undefined) {
    return fields;
  }
  return Object.fromEntries([...Object.entries(fields), ['_tag', tool.invoke.commandTag]]);
};

const moduleIdOf = (id: string, tool: McpCatalogTool | undefined): string => tool?.moduleId ?? id.split('/')[0] ?? '';
const titleOf = (tool: McpCatalogTool): string => tool.title.cs;
const textOr = (value: string | undefined, fallback: string): string => {
  const text = value?.trim() ?? '';
  return text === '' ? fallback : text;
};
const reviewLink = (url: string): ToolContent => ({
  description: 'Návrh schválí nebo zamítne člověk v OntOS.',
  mimeType: 'text/html',
  name: 'ke-schvaleni',
  title: 'OntOS › Ke schválení',
  type: 'resource_link',
  uri: url,
});

const revisionFrom = (module: McpCatalogModule, answer: Schema.Json, tag: string | undefined): number | undefined => {
  const { revision } = module;
  if (revision === undefined) {
    return undefined;
  }
  const field =
    revision.fieldsByCommandPrefix.find((entry) => tag !== undefined && tag.startsWith(entry.prefix))?.field ??
    revision.field;
  return Result.getSuccess(selectPath(answer, field)).pipe(
    Option.flatMap(Schema.decodeUnknownOption(Schema.Finite)),
    Option.getOrUndefined,
  );
};

/** Live flags of a successful revision read: modules need not advertise additional write flags. */
const snapshotAllowsWrite = (tool: McpCatalogTool, flags: Schema.Json): boolean =>
  !isJsonObject(flags) ||
  (flags['canWrite'] !== false && (tool.liveRight === undefined || flags[tool.liveRight] !== false));

const checkActionInput = (tool: McpCatalogTool, input: Schema.JsonObject): ToolResult | undefined => {
  const problems = inputProblems(tool.inputSchema, input, 'input');
  return problems === undefined
    ? undefined
    : errorResult(MSG_INVALID_INPUT(tool.id, problems), { 'ontos/code': 'invalid_input' });
};

export const buildConnectionTools = (context: McpToolContext): readonly ToolSpec[] => {
  const { backend, catalog, description: d } = context;
  // Do not advertise an uncallable typed tool or consume the typed-tool budget for a genuine key collision.
  // ontos_execute / ontos_propose keep the complete Action input nested separately from caller intent.
  const plan = planTools(
    {
      ...catalog,
      modules: catalog.modules.map((module) => ({
        ...module,
        tools: module.tools.filter((tool) => tool.access === 'read' || !hasIntentCollision(tool.inputSchema)),
      })),
    },
    d,
  );
  const moduleOf = (moduleId: string): McpCatalogModule | undefined => findModule(catalog, moduleId);
  const labelOf = (moduleId: string): string =>
    moduleOf(moduleId)?.label.cs ?? d.modules.find((module) => module.moduleId === moduleId)?.label ?? moduleId;
  const reviewUrl = `${context.publicOrigin}/cs/sprava/ke-schvaleni`;
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

  const toolError = (error: ToolFailure): Effect.Effect<ToolResult> => {
    if (Predicate.isTagged(error, 'InvalidToolArguments')) {
      return Effect.succeed(errorResult(error.message, { 'ontos/code': 'invalid_arguments' }));
    }
    if (!Predicate.isTagged(error, 'ModuleProblem')) {
      return Effect.succeed(errorResult(error.message));
    }
    if (error.status === 401) {
      return Effect.succeed(
        errorResult('Připojení k OntOS už neplatí. Připojte aplikaci znovu.', {
          'mcp/www_authenticate': [
            `Bearer resource_metadata="${context.prmUrl}", scope="ontos", error="invalid_token"`,
          ],
        }),
      );
    }
    const problem = czechProblem(error);
    return Schema.decodeUnknownEffect(Schema.JsonObject)(problem.meta).pipe(
      Effect.map((meta) => errorResult(problem.text, meta)),
      // A malformed locally generated diagnostic is a defect; retain its SchemaError at the SDK boundary.
      Effect.orDie,
    );
  };
  const instrument = (
    name: string,
    title: string,
    toolDescription: string,
    inputSchema: JsonObject,
    annotations: ToolAnnotationsSpec,
    run: ToolRun,
    outputSchema?: JsonObject,
  ): ToolSpec => {
    const spec: ToolSpec = {
      annotations,
      description: toolDescription,
      handler: (args) =>
        Schema.decodeEffect(Schema.JsonObject)(args).pipe(
          Effect.mapError(
            (cause) => new InvalidToolArguments({ cause, message: 'Argumenty nástroje musí být objekt JSON.' }),
          ),
          Effect.flatMap((input) => {
            const problems = inputProblems(inputSchema, input);
            return problems === undefined
              ? run(input)
              : Effect.succeed(
                  errorResult(`Neplatné argumenty nástroje ${name}: ${problems}.`, {
                    'ontos/code': 'invalid_arguments',
                  }),
                );
          }),
          Effect.matchEffect({ onFailure: toolError, onSuccess: Effect.succeed }),
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
      title,
    };
    return outputSchema === undefined ? spec : { ...spec, outputSchema };
  };

  const call = Effect.fn('Mcp.callModule')(
    (
      tool: McpCatalogTool,
      path: string,
      body: Schema.Json,
      options: { readonly idempotencyKey?: string; readonly referenceAudiences?: readonly string[] } = {},
    ): Effect.Effect<Schema.Json, ModuleProblem | ModuleUnavailable> =>
      backend
        .callModule(tool.appId, path, body, options)
        .pipe(
          Effect.flatMap((answer) =>
            answer.status < 200 || answer.status >= 300
              ? Effect.fail(problemOf(answer.status, answer.body))
              : Effect.succeed(answer.body),
          ),
        ),
  );

  const runRead = Effect.fn('Mcp.runRead')(function* runRead(
    tool: McpCatalogTool,
    input: Schema.JsonObject,
    options: { readonly limit?: number; readonly offset?: number; readonly path?: string },
  ) {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_READ_LIMIT, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const answer = yield* call(tool, tool.invoke.path, input);
    const path = options.path?.trim() ?? '';
    const selected = path === '' ? answer : yield* Effect.fromResult(selectPath(answer, path));
    const read = yield* Schema.decodeEffect(ReadPage)(
      paginateReadResult(selected, { basePath: path, limit, offset }),
    ).pipe(
      Effect.mapError(
        (cause) => new ModuleUnavailable({ cause, message: 'Modul nevrátil platný JSON výsledek čtení.' }),
      ),
    );
    const result = {
      data: read.data,
      id: tool.id,
      legalEntityId: d.legalEntityId,
      omitted: read.omitted,
      truncated: read.truncated,
    };
    return path === '' ? result : { ...result, path };
  });

  const runReadTool = Effect.fn('Mcp.readTool')((
    id: string,
    input: Schema.JsonObject | undefined,
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
      Effect.flatMap((read) =>
        okResult(read.truncated.length > 0 || read.omitted.length > 0 ? { ...read, noteCs: READ_NOTE_CS } : read),
      ),
    );
  });

  /** The answer of the module's revision read (also carries live right flags such as `canWrite`). */
  const revisionAnswer = Effect.fn('Mcp.readRevision')((module: McpCatalogModule, tool: McpCatalogTool) =>
    module.revision === undefined ? Effect.succeed(null) : call(tool, module.revision.path, module.revision.query),
  );

  const executeDirect = Effect.fn('Mcp.executeDirect')((
    tool: McpCatalogTool,
    input: Schema.JsonObject,
    key: CallerIntentKey,
    snapshot: Schema.Json,
  ): Effect.Effect<Schema.Json, ModuleProblem | ModuleUnavailable> => {
    const module = moduleOf(tool.moduleId);
    const options = { referenceAudiences: tool.referenceAudiences };
    if (tool.invoke.commandTag === undefined || module === undefined) {
      return call(tool, tool.invoke.path, input, { ...options, idempotencyKey: key });
    }
    const command = commandOf(tool, input);
    const revisionOf = (answer: Schema.Json): Effect.Effect<number, ModuleUnavailable> => {
      const revision = revisionFrom(module, answer, tool.invoke.commandTag);
      return revision === undefined
        ? Effect.fail(new ModuleUnavailable({ message: MSG_NO_REVISION(labelOf(tool.moduleId)) }))
        : Effect.succeed(revision);
    };
    const given = input['expectedRevision'];
    const send = (revision: number, idempotencyKey: CallerIntentKey) =>
      call(tool, tool.invoke.path, { command, expectedRevision: revision }, { ...options, idempotencyKey });
    const supplied = Schema.decodeUnknownOption(Schema.Finite)(given);
    return (Option.isSome(supplied) ? Effect.succeed(supplied.value) : revisionOf(snapshot)).pipe(
      Effect.flatMap((revision) => send(revision, key)),
    );
  });

  const liveWriteAllowed = Effect.fn('Mcp.liveWriteAllowed')((tool: McpCatalogTool): Effect.Effect<boolean> => {
    const module = moduleOf(tool.moduleId);
    if (module?.revision === undefined) {
      return Effect.succeed(true);
    }
    return revisionAnswer(module, tool).pipe(
      Effect.map((flags) => snapshotAllowsWrite(tool, flags)),
      Effect.orElseSucceed(() => false),
    );
  });

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

  const proposeBatch = Effect.fn('Mcp.proposeBatch')(function* proposeBatch(
    instruction: string,
    items: readonly ProposeItem[],
    idempotencyKey: CallerIntentKey,
    runId: string | undefined,
  ) {
    const proposals = items.map((item): AgentProposalInput => {
      const proposal: AgentProposalInput = {
        actionSlug: actionSlugOf(item.tool),
        appId: item.tool.appId,
        command: agentCommandOf(commandOf(item.tool, item.input)),
        diff: [],
        reason: item.reason,
        risk: item.tool.destructive ? 'high' : 'medium',
        summary: item.summary.slice(0, 300),
        targetLabel: item.targetLabel.slice(0, 300),
      };
      return item.tool.referenceAudiences.length === 0
        ? proposal
        : { ...proposal, referenceAudiences: item.tool.referenceAudiences };
    });
    const request = {
      agentLabel: `${d.acting.displayName} přes ${d.client.name}`.slice(0, 300),
      instruction: instruction.slice(0, 4000),
      legalEntityId: d.legalEntityId,
      proposals,
    };
    const response = yield* backend.submitProposals(runId === undefined ? request : { ...request, runId }, {
      idempotencyKey,
    });
    const batchUrl = `${context.publicOrigin}${response.reviewPath}?davka=${encodeURIComponent(response.batchId)}`;
    const result = {
      batchId: response.batchId,
      messageCs: MSG_PROPOSED,
      proposalIds: response.proposalIds,
      replayed: response.replayed,
      reviewUrl: batchUrl,
      status: 'proposed',
    };
    const [proposalId] = response.proposalIds;
    return yield* okResult(proposalId === undefined ? result : { ...result, proposalId }, [reviewLink(batchUrl)]);
  });

  const executeOne = Effect.fn('Mcp.executeOne')(function* executeOne(
    id: string,
    input: Schema.JsonObject | undefined,
    reason: string | undefined,
    idempotencyKey: CallerIntentKey | undefined,
    runId: string | undefined,
  ): Effect.fn.Return<ToolResult, ToolFailure> {
    if (idempotencyKey === undefined) {
      return errorResult('Chybí povinné pole idempotencyKey.', { 'ontos/code': 'invalid_arguments' });
    }
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
    const key = idempotencyKey;
    if (d.writePolicy === 'direct') {
      const module = moduleOf(tool.moduleId);
      // Reuse this successful read only within this command; the owner Action still authorizes the write.
      const snapshot = module === undefined ? null : yield* revisionAnswer(module, tool);
      if (!snapshotAllowsWrite(tool, snapshot)) {
        return errorResult(MSG_NO_LIVE_RIGHT(labelOf(tool.moduleId)));
      }
      const hash = yield* requestHash(context.crypto, tool.id, payload);
      const replay = directReplays.lookup(d.grantId, idempotencyKey, hash);
      if (replay.kind === 'hit') {
        // Only this Shell's executed-result envelope is stored here; invalid cached data is a defect.
        const cached = yield* Schema.decodeUnknownEffect(ExecutedResult)(replay.result).pipe(Effect.orDie);
        return yield* okResult({ ...cached, replayed: true });
      }
      if (replay.kind === 'conflict') {
        return errorResult(MSG_IDEMPOTENCY_CONFLICT, { 'ontos/code': 'idempotency_key_reused' });
      }
      const result = yield* executeDirect(tool, payload, key, snapshot);
      const link = moduleLink(tool.moduleId);
      const resultValue = {
        messageCs: MSG_EXECUTED,
        replayed: false,
        result,
        status: 'executed',
      };
      const value = link?.type === 'resource_link' ? { ...resultValue, url: link.uri } : resultValue;
      directReplays.remember(d.grantId, idempotencyKey, hash, value);
      return yield* okResult(value, link === undefined ? [] : [link]);
    }
    const trimmed = (reason ?? '').trim();
    const reasonText = trimmed.length >= 3 ? trimmed : `Změna navržená přes ${d.client.name}`;
    const title = titleOf(tool);
    return yield* proposeBatch(
      trimmed === '' ? title : trimmed,
      [{ input: payload, reason: reasonText, summary: title, targetLabel: title, tool }],
      key,
      runId,
    );
  });

  /** Single-tool inspection includes the current live write flags; catalog search never runs preflight reads. */
  const capabilityDetail = Effect.fn('Mcp.capabilityDetail')(function* capabilityDetail(id: string) {
    const tool = findTool(catalog, id);
    if (tool === undefined) {
      return errorResult(MSG_UNKNOWN(id));
    }
    if (!canRead(d, tool.moduleId)) {
      return errorResult(MSG_NO_READ(labelOf(tool.moduleId)));
    }
    const module = moduleOf(tool.moduleId);
    const requiresGenericWrapper = tool.access === 'write' && hasIntentCollision(tool.inputSchema);
    const detail = {
      descriptionCs: requiresGenericWrapper
        ? `${descriptionOf(tool)} Použij ontos_execute {id, input, idempotencyKey}: celý vstup akce patří do input; vnější klíč identifikuje tuto změnu.`
        : descriptionOf(tool),
      id: tool.id,
      inputSchema: tool.inputSchema,
      kind: tool.access === 'read' ? 'read' : 'action',
      moduleCs: labelOf(tool.moduleId),
      moduleId: tool.moduleId,
      titleCs: tool.title.cs,
      titleEn: tool.title.en,
      toolName: requiresGenericWrapper ? 'ontos_execute' : tool.name,
    };
    if (tool.access === 'read') {
      return yield* okResult(detail);
    }
    const writable =
      canWrite(d, module) &&
      isOffered(tool, d.writePolicy, d.acting.kind) &&
      (d.writePolicy !== 'direct' || (yield* liveWriteAllowed(tool)));
    return yield* okResult({ ...detail, destructive: tool.destructive, proposable: canPropose(d, module), writable });
  });

  /** Search one visible module, independently bounding its read and Action rows. */
  const capabilityModule = (module: McpCatalogModule, tokens: readonly string[]): Schema.JsonObject | undefined => {
    const moduleCs = labelOf(module.moduleId);
    const moduleText = `${module.moduleId} ${moduleCs} ${module.label.en} ${module.description.cs} ${module.description.en} ${module.keywords}`;
    const write = canWrite(d, module);
    const moduleHit = tokens.length > 0 && matchesTokens(tokens, moduleText);
    const reads: Schema.JsonObject[] = [];
    const actions: Schema.JsonObject[] = [];
    for (const tool of module.tools) {
      if (!moduleHit && !matchesTokens(tokens, `${tool.id} ${tool.title.cs} ${tool.title.en} ${moduleText}`)) {
        continue;
      }
      const row = { id: tool.id, titleCs: tool.title.cs, titleEn: tool.title.en };
      if (tool.access === 'read' && reads.length < 60) {
        reads.push(row);
      } else if (
        tool.access === 'write' &&
        write &&
        isOffered(tool, d.writePolicy, d.acting.kind) &&
        actions.length < 60
      ) {
        actions.push({ ...row, destructive: tool.destructive });
      }
    }
    if (tokens.length > 0 && reads.length === 0 && actions.length === 0) {
      return undefined;
    }
    const entry = {
      actions,
      descriptionCs: module.description.cs,
      moduleCs,
      moduleId: module.moduleId,
      reads,
      write,
    };
    const unavailableApproval =
      !write && grantAllowsWrite(d, module.moduleId) && d.writePolicy === 'approval' && !module.approvals;
    return unavailableApproval ? { ...entry, writeNoteCs: NOT_PROPOSABLE_NOTE } : entry;
  };

  const capabilities = Effect.fn('Mcp.capabilities')((args: typeof CapabilitiesInput.Type) => {
    const { id, moduleId: moduleFilter, query } = args;
    if (id !== undefined) {
      return capabilityDetail(id);
    }
    const tokens = queryTokens(query ?? '');
    const modules: NonNullable<ReturnType<typeof capabilityModule>>[] = [];
    for (const module of catalog.modules) {
      if (!canRead(d, module.moduleId) || (moduleFilter !== undefined && module.moduleId !== moduleFilter)) {
        continue;
      }
      const entry = capabilityModule(module, tokens);
      if (entry !== undefined) {
        modules.push(entry);
      }
    }
    return okResult({
      hint: 'Čtení: ontos_read {id, input}. Zápis: ontos_execute {id, input, reason, idempotencyKey}. Při opakování zachovejte klíč i celý vstup. Vstupní schéma: ontos_capabilities {id}.',
      modules,
      writePolicy: d.writePolicy,
      writePolicyCs: WRITE_POLICY_CS[d.writePolicy],
    });
  });

  const propose = Effect.fn('Mcp.propose')(function* propose(args: typeof ProposeInput.Type) {
    const items: ProposeItem[] = [];
    for (const [index, change] of args.changes.entries()) {
      const checked = writeTargetOf(change.id, 'propose');
      if ('error' in checked) {
        return checked.error;
      }
      const input = change.input ?? {};
      const invalid = checkActionInput(checked.tool, input);
      if (invalid !== undefined) {
        const [first] = invalid.content;
        const text = first?.type === 'text' ? first.text : '';
        return errorResult(`Změna č. ${index + 1}: ${text}`, { 'ontos/code': 'invalid_input' });
      }
      const title = titleOf(checked.tool);
      items.push({
        input,
        reason: textOr(change.reason, `Změna navržená přes ${d.client.name}`),
        summary: textOr(change.summary, title),
        targetLabel: textOr(change.targetLabel, title),
        tool: checked.tool,
      });
    }
    return yield* proposeBatch(
      args.instruction.trim() === '' ? 'Dávka změn' : args.instruction,
      items,
      args.idempotencyKey,
      args.runId,
    );
  });

  const listProposals = backend.listProposals.pipe(
    Effect.flatMap((queue) =>
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
  );

  const whoami = () =>
    Effect.suspend(() =>
      okResult({
        acting: d.acting,
        client: { host: d.client.host, kind: d.client.kind, name: d.client.name },
        company: { legalEntityId: d.legalEntityId, legalName: d.legalName },
        delegatedBy: d.delegatedBy,
        modules: d.modules.map((granted) => {
          const module = moduleOf(granted.moduleId);
          const write = canWrite(d, module);
          const entry = {
            label: labelOf(granted.moduleId),
            moduleId: granted.moduleId,
            read: granted.read,
            tools: module?.tools.length ?? 0,
            write,
          };
          return !write && grantAllowsWrite(d, granted.moduleId)
            ? { ...entry, writeNoteCs: NOT_PROPOSABLE_NOTE }
            : entry;
        }),
        profile_id: d.profileId,
        reviewUrl,
        typedTools: { count: plan.typed.length, overCap: plan.typedOverCap },
        writePolicy: d.writePolicy,
        writePolicyCs: WRITE_POLICY_CS[d.writePolicy],
      }),
    );

  const genericSpecs = {
    ontos_capabilities: instrument(
      'ontos_capabilities',
      'Co smím v OntOS',
      'Najde čtení a akce, které toto připojení smí použít, podle textu (query, bez ohledu na diakritiku) nebo modulu (moduleId); s parametrem id vrátí popis a vstupní schéma jedné položky. / Search what this connection may read or change; pass id for the input schema.',
      toolInputSchema(CapabilitiesInput),
      { openWorldHint: false, readOnlyHint: true },
      (args) => decodeToolInput(CapabilitiesInput, args).pipe(Effect.flatMap(capabilities)),
      CAPABILITIES_OUTPUT,
    ),
    ontos_execute: instrument(
      'ontos_execute',
      d.writePolicy === 'direct' ? 'Provést změnu' : 'Navrhnout změnu ke schválení',
      d.writePolicy === 'direct'
        ? 'Provede akci (zápis) v OntOS přes governed Action; server ověří oprávnění a zapíše deník. id z ontos_capabilities. Se stejným idempotencyKey se změna neprovede dvakrát. / Runs a governed Action.'
        : 'Uloží změnu jako NÁVRH, který schválí člověk v OntOS (Nastavení › Ke schválení); data se hned nezmění. Vrací proposalId a reviewUrl. / Submits a proposal a person approves.',
      toolInputSchema(ExecuteInput),
      { destructiveHint: d.writePolicy === 'direct', idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      (args) =>
        decodeToolInput(ExecuteInput, args).pipe(
          Effect.flatMap((input) => executeOne(input.id, input.input, input.reason, input.idempotencyKey, input.runId)),
        ),
      WRITE_OUTPUT,
    ),
    ontos_list_proposals: instrument(
      'ontos_list_proposals',
      'Moje návrhy ke schválení',
      'Stav návrhů změn, které toto připojení odeslalo ke schválení. / Status of proposals sent by this connection.',
      toolInputSchema(EmptyInput),
      { openWorldHint: false, readOnlyHint: true },
      () => listProposals,
      PROPOSALS_OUTPUT,
    ),
    ontos_propose: instrument(
      'ontos_propose',
      'Navrhnout více změn najednou',
      'Pošle dávku změn ke schválení člověkem (i když připojení smí zapisovat přímo). / Sends a batch of proposals for human approval.',
      toolInputSchema(ProposeInput),
      { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
      (args) => decodeToolInput(ProposeInput, args).pipe(Effect.flatMap(propose)),
      WRITE_OUTPUT,
    ),
    ontos_read: instrument(
      'ontos_read',
      'Načíst data',
      'Načte data z čtení (governed read), ke kterému má připojení přístup. Odpověď je vždy krátká: seznamy se stránkují (limit, offset) a velké části se vynechají (omitted) – načtete je přes path. / Read data through a governed read; page with limit/offset, drill into omitted parts with path.',
      toolInputSchema(ReadInput),
      { openWorldHint: false, readOnlyHint: true },
      (args) =>
        decodeToolInput(ReadInput, args).pipe(
          Effect.flatMap((input) => {
            const { id, input: payload, ...options } = input;
            return runReadTool(id, payload, options);
          }),
        ),
      READ_OUTPUT,
    ),
    ontos_whoami: instrument(
      'ontos_whoami',
      'Kdo jsem (profil připojení)',
      'Profil tohoto připojení: firma, za koho aplikace jedná, moduly a režim zápisu. Vrací profile_id. Zavolej jako první. / Connection profile (profile_id, company, acting identity, modules, write mode); call it first.',
      toolInputSchema(EmptyInput),
      { openWorldHint: false, readOnlyHint: true },
      whoami,
      WHOAMI_OUTPUT,
    ),
  } satisfies Record<GenericToolName, ToolSpec>;

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
      Effect.fn('Mcp.executeTyped')(function* executeTyped(args: Schema.JsonObject) {
        const input = new Map<string, Schema.Json>();
        const metadata = new Map<string, Schema.Json>();
        for (const [key, value] of Object.entries(args)) {
          if (extras.has(key)) {
            metadata.set(key, value);
          } else {
            input.set(key, value);
          }
        }
        const intent = yield* decodeToolInput(TypedWriteIntent, Object.fromEntries(metadata));
        return yield* executeOne(
          tool.id,
          Object.fromEntries(input),
          intent.reason,
          intent.idempotencyKey,
          intent.runId,
        );
      }),
      WRITE_OUTPUT,
    );
  });

  const genericTools = plan.generic.map((name) => genericSpecs[name]);
  return [...genericTools, ...typedSpecs];
};
