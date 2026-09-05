/**
 * effect-native/no-promise-first-scaffold-templates
 *
 * Audit findings enforced (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`):
 *
 *   - **A8 "Fix the generators before generating more code."** "Generators currently emit
 *     **Promise-first browser code, repeated route argument types, per-call clients**, manual error
 *     switches, and—in one stale template—manual JWK parsing that production Contacts had already
 *     replaced." Evidence sites: `scripts/scaffolding/microvertical-page/scaffold.mts:236`, `:243`,
 *     `:374` and `scripts/scaffolding/governed-contribution/scaffold.mts:281`. The A8 target is that
 *     scaffolds emit "Schema-first contracts, **branded route parameters**, **a shared browser
 *     runtime**, **generated Effect data hooks**, exhaustive typed error handling, shared form
 *     codecs, Layer-provided test seams".
 *   - **A9 "Preserve typed Effects through the frontend."** "Roughly 40 scattered browser
 *     `runPromise` calls, **fresh clients per operation**, ten route-specific error classifiers, and
 *     **repeated manual route/form parsing**." Target: "One browser `ManagedRuntime`",
 *     "**Long-lived HttpApi clients**", "One query adapter that runs Effects, threads cancellation
 *     signals, and preserves typed failures until the React/TanStack boundary", "**Schema-driven
 *     route/search parameters through `Schema.standardSchemaV1`**".
 *   - **A1 "Establish one process-level Layer and ManagedRuntime composition model."**
 *     "Browser clients have no stable runtime at all." Target: "**Construct HttpApi clients once
 *     from injected `HttpClient`**", "Create one `ManagedRuntime` per long-lived host/runtime",
 *     "Capture the runtime at forced Promise adapters rather than calling bare `Effect.runPromise`."
 *
 * Why a template rule rather than a source rule: A9 counts ~40 browser `runPromise` seams and ten
 * route-local classifiers in code that was *written once*. A generator emits the same shape once per
 * generated page, action boundary or governed contribution, forever, and it is the shape every
 * contributor copies because a generator produced it. A8 is explicitly sequenced before the frontend
 * migration in the audit's recommended order ("Generators and gates: ensure all newly generated code
 * follows the target architecture") for exactly that reason: fixing the generator is what stops A9
 * from being re-introduced faster than it is paid down. This rule is the A9 guard placed at A8's
 * multiplier, so Promise-first frontend plumbing cannot re-enter generated pages.
 *
 * ## What is detected
 *
 * Only the *emitted* text of generator templates is scanned — the static quasis of every template
 * literal in a file matching `templatePaths` (scaffolds, generators, codegen, `*.template.*`).
 * Quasis are joined into one buffer with a single placeholder character standing in for each
 * `${...}` interpolation, so a shape split by an interpolation (`Record<${parameterType}, string>>>`)
 * still matches. Reports highlight the containing quasi/string literal (whole template across quasis).
 *
 * Three groups, each with its own diagnostic naming the Effect-native replacement:
 *
 *   1. `promiseFirst` — `async`, `await`, `.then(`, `new Promise(`,
 *      `Effect.runPromise` / `runSync` / `runFork` / `runPromiseExit`, and `fetch(` in emitted code.
 *      A8's "Promise-first browser code" and A9's "~40 scattered browser `runPromise` calls".
 *      Generated data access belongs in Effect hooks running on the shared browser `ManagedRuntime`,
 *      with the Promise adapter owned once by that runtime rather than re-derived per generated file.
 *   2. `perCallClient` — `makeEffectHttpApiClient(` / `HttpApiClient.make(` emitted *inside* an
 *      operation body: delimiter-bounded function/arrow spans are lexical lifetime hints; nested
 *      Layer-owned initializers are excluded, and blank lines do not reset the enclosing context. `strictPerCallClient: true` reports every construction site
 *      in emitted code instead. This is A9's "fresh clients per operation" and A1's "Construct
 *      HttpApi clients once from injected `HttpClient`" —
 *      `scripts/scaffolding/governed-contribution/scaffold.mts:281`, whose `renderApiClient`
 *      template puts `makeEffectHttpApiClient(...)` in the body of *every* generated operation.
 *   3. `routeParams` — `type XRouteParams = Readonly<Partial<Record<..., string>>>` and the
 *      equivalent SearchParams declarations. Unrelated Record types are not route parameters. A8's "repeated route argument types" and A9's "Schema-driven route/search
 *      parameters through `Schema.standardSchemaV1`" —
 *      `scripts/scaffolding/microvertical-page/scaffold.mts:236/243`, which emits an all-optional
 *      `Record<string-literal-union, string>` per generated page instead of a Schema with branded
 *      identifiers.
 *
 * ## What is deliberately allowed
 *
 *   - **The generator's own code.** Only template text is scanned. A scaffold that is itself an
 *     `async` function `await`ing `writeFile`, or that calls `fetch` to check a registry, is the
 *     script's own business (owned by `no-async-script-program` / `no-direct-node-io-in-scripts`),
 *     not this rule's.
 *   - **Everything outside `templatePaths`.** Hand-written `Effect.runPromise` in a browser file is
 *     A9's own rules (`no-scattered-browser-effect-run`, `no-bare-effect-run`,
 *     `no-per-operation-http-api-client`); this rule exists solely for the generator multiplier.
 *   - **Test files** (`scripts/scaffolding/tests/**`, `*.test.mts`, `*.spec.mts`). The golden-output
 *     tests quote the current generator output verbatim and would double-report every finding; the
 *     audit's D tier also blesses hand-written fixtures and deliberately malformed casts in tests.
 *   - **Every "Existing patterns to preserve" and D-tier shape.** "Promise adapters forced by React,
 *     TanStack, Modern.js, Playwright, Drizzle, and Node process entrypoints" are blessed *as the
 *     single outer seam*, and "Bare `Effect.runPromise` is acceptable at the single outer process or
 *     framework adapter seam; the problem is repeated deep re-entry" — a generator emitting the same
 *     seam into every generated module is by construction *not* a single seam, which is the case A8
 *     names. A template that emits the Effect-native shape instead (`useEffectQuery` on the shared
 *     runtime, `const client = yield* ContactsClient`, `Schema.Struct({ customerId: CustomerId })`,
 *     `Schema.standardSchemaV1`, `Layer.orDie` at a generated startup root, `JSON.stringify` in an
 *     emitted external test fixture, native array operations) matches nothing here.
 *   - **Narrow, explicit escape hatches, all off or defaulted in production:** `templatePaths`,
 *     `promiseFirstPatterns`, `perCallClientPatterns`, `routeParamPatterns` (each replaces its
 *     group's defaults wholesale — pass `[]` to disable that group), `strictPerCallClient`
 *     (`false`), and `exclude` (build output, `node_modules`, `*.d.ts`).
 *
 * Static template/string fragments are scanned lexically, not parsed as generated TypeScript.
 * Comments, emitted quoted data and direct generator log/shell/error arguments are skipped.
 * Explicit Effect import aliases are recognized; dynamic fragments, regex literals, arbitrary
 * binding shadowing and helper-returned source are not inferred. Function/Layer spans are hints,
 * not proof of generated scope identity or lifetime. Report-only.
 *
 * Scope lives in the rule, so `oxlint.config.ts` only needs
 * `'effect-native/no-promise-first-scaffold-templates': 'error'`.
 *
 * Report-only: no fixers, no suggestions. Nothing in `apps/`, `verticals/`, `packages/` or
 * `scripts/` is edited to satisfy it.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production defaults instead of forcing the
 * fixture config to pass loosened options (`run-on-repo.mts` reuses that fixture config verbatim
 * against the real repository).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Files whose template literals are emitted as source code into someone else's module. */
const DEFAULT_TEMPLATE_PATHS: readonly string[] = [
  'scripts/scaffolding/**',
  'scripts/generate-*.{ts,mts,cts,tsx}',
  'scripts/**/generate-*.{ts,mts,cts,tsx}',
  'scripts/**/*scaffold*.{ts,mts,cts,tsx}',
  '**/scaffolding/**',
  '**/scaffolds/**',
  '**/generators/**',
  '**/codegen/**',
  '**/templates/**',
  '**/*.template.{ts,mts,cts,tsx,js,mjs}',
];

/** Generated or vendored output that is never hand-edited. */
const DEFAULT_EXCLUDE: readonly string[] = [
  '**/dist/**',
  '**/.output/**',
  '**/node_modules/**',
  '**/*.d.ts',
];

/**
 * A8 "Promise-first browser code" / A9 "~40 scattered browser `runPromise` calls". Sources, not
 * `RegExp`s, so the whole list stays expressible from `oxlint.config.ts`; compiled with `gu`.
 */
const DEFAULT_PROMISE_FIRST: readonly string[] = [
  String.raw`\basync\b`,
  String.raw`\bawait\b`,
  String.raw`\.\s*then\s*\(`,
  String.raw`\bnew\s+Promise\s*[<(]`,
  String.raw`\bPromise\s*\.\s*(?:all|allSettled|race|any|resolve|reject)\s*\(`,
  String.raw`\bEffect\.run(?:Promise|Sync|Fork)(?:Exit)?\b`,
  String.raw`\bfetch\s*\(`,
];

/** A9 "fresh clients per operation" / A1 "Construct HttpApi clients once from injected HttpClient". */
const DEFAULT_PER_CALL_CLIENT: readonly string[] = [
  String.raw`(?:makeEffectHttpApiClient|HttpApiClient\s*\.\s*make)\s*\(`,
];

/** A8 "repeated route argument types" / A9 "Schema-driven route/search parameters". */
const DEFAULT_ROUTE_PARAMS: readonly string[] = [
  String.raw`(?:Route|Search)Params\s*=\s*Readonly<\s*Partial<\s*Record<`,
  String.raw`(?:Route|Search)Params\s*=\s*(?:Readonly<\s*)?(?:Partial<\s*)?Record<[^>]*,\s*string\s*>`,
];

/** The `routeParams` group only scans templates that actually declare route parameters. */
const ROUTE_PARAMS_GATE = /(?:Route|Search)Params/u;

const INTERPOLATION = '_';

/** Longest snippet echoed back in a diagnostic message. */
const SNIPPET_LIMIT = 72;

type Group = 'promiseFirst' | 'perCallClient' | 'routeParams';

interface RuleOptions {
  readonly templatePaths: readonly string[];
  readonly promiseFirstPatterns: readonly string[];
  readonly perCallClientPatterns: readonly string[];
  readonly routeParamPatterns: readonly string[];
  readonly strictPerCallClient: boolean;
  readonly exclude: readonly string[];
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly group: Group;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    templatePaths: stringArray(record.templatePaths, DEFAULT_TEMPLATE_PATHS),
    promiseFirstPatterns: stringArray(record.promiseFirstPatterns, DEFAULT_PROMISE_FIRST),
    perCallClientPatterns: stringArray(record.perCallClientPatterns, DEFAULT_PER_CALL_CLIENT),
    routeParamPatterns: stringArray(record.routeParamPatterns, DEFAULT_ROUTE_PARAMS),
    strictPerCallClient: boolean(record.strictPerCallClient, false),
    exclude: stringArray(record.exclude, DEFAULT_EXCLUDE),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real scaffold paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Compile option sources once per file; a source that does not compile disables itself, not the rule. */
function compilePatterns(sources: readonly string[]): readonly RegExp[] {
  const compiled: RegExp[] = [];
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, 'gu'));
    } catch {
      // A malformed user-supplied pattern must never take the whole lint run down.
    }
  }
  return compiled;
}

/** Collapse matched template text to one short, readable line for the diagnostic. */
function snippetOf(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT - 1)}…` : flat;
}

type StringNode = Extract<ESTree.Node, { type: 'TemplateLiteral' | 'Literal' }>;
/** Cooked text is scanned; interpolation expressions remain opaque. */
function emittedText(node: StringNode): string {
  return node.type === 'TemplateLiteral'
    ? node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(INTERPOLATION)
    : typeof node.value === 'string'
      ? node.value
      : '';
}
/** Quasi-level location is intentional: escaped/CRLF text has no 1:1 raw offset mapping. */
function reportNode(node: StringNode, start: number, end: number): ESTree.Node {
  if (node.type !== 'TemplateLiteral') return node;
  let offset = 0;
  for (const quasi of node.quasis) {
    const length = (quasi.value.cooked ?? quasi.value.raw).length;
    if (start >= offset && end <= offset + length) return quasi;
    offset += length + INTERPOLATION.length;
  }
  return node;
}
/** This is a lexical scanner, not a generated JS parser. Regex literals and arbitrary dynamic
 * fragments are not reconstructed. Comments and quoted emitted data are not executable code. */
function maskText(text: string, strings = true): string {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/gu,
    (part) => (strings || part.startsWith('/') ? part.replace(/[^\r\n]/g, ' ') : part),
  );
}
function driverText(node: ESTree.Node): boolean {
  if (
    node.parent !== null &&
    node.parent !== undefined &&
    [
      'ImportDeclaration',
      'ImportExpression',
      'ExportNamedDeclaration',
      'ExportAllDeclaration',
    ].includes(node.parent.type)
  )
    return true;
  let current = node;
  while (current.parent !== null && current.parent !== undefined) {
    const parent = current.parent;
    if (/Function/u.test(parent.type) || parent.type === 'ClassBody') return false;
    if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
      const callee = parent.callee;
      if (
        callee.type === 'Identifier' &&
        /^(?:Error|TypeError|exec|execSync|execFile|execFileSync|spawn|spawnSync)$/u.test(
          callee.name,
        )
      )
        return true;
      if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'console'
      )
        return true;
      return false;
    }
    if (
      ['VariableDeclarator', 'ReturnStatement', 'TemplateLiteral', 'Program'].includes(parent.type)
    )
      return false;
    current = parent;
  }
  return false;
}
interface Span {
  readonly start: number;
  readonly end: number;
}
/** End of a balanced expression/block. Whitespace (including blank lines) is never a boundary. */
function expressionEnd(text: string, start: number): number {
  const closes: string[] = [];
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (closes.length === 0 && /[;,)\]}]/u.test(char)) return i;
    if (char === '(' || char === '[' || char === '{')
      closes.push(char === '(' ? ')' : char === '[' ? ']' : '}');
    else if (char === closes.at(-1)) {
      closes.pop();
      if (closes.length === 0 && start === text.indexOf('{', start)) return i + 1;
    }
  }
  return text.length;
}
function closingParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}
/** Delimiter-bounded function/Layer hints, not scope or lifetime proof. */
function operationSpans(text: string): { functions: Span[]; layers: Span[] } {
  const functions: Span[] = [];
  const layers: Span[] = [];
  for (const match of text.matchAll(/=>\s*|\bfunction\s*\*?\s*(?:[\w$]+\s*)?\(/gu)) {
    let start = match.index + match[0].length;
    if (match[0].startsWith('function')) {
      start = closingParen(text, start - 1);
      // Skip a return annotation without accidentally reaching a different declaration.
      const brace = text.indexOf('{', start);
      if (brace < 0 || /[;=]/u.test(text.slice(start, brace))) continue;
      start = brace;
    }
    while (/\s/u.test(text[start] ?? 'X')) start += 1;
    functions.push({ start: match.index, end: expressionEnd(text, start) });
  }
  for (const match of text.matchAll(/\bLayer\s*\.\s*(?:effect|scoped|sync|succeed)\s*\(/gu)) {
    let end = closingParen(text, match.index + match[0].length - 1);
    const following = /^\s*\(/u.exec(text.slice(end));
    if (following !== null) end = closingParen(text, end + following[0].length - 1);
    layers.push({ start: match.index, end });
  }
  return { functions, layers };
}
/** Resolve only explicit emitted Effect import aliases, never arbitrary *.runPromise receivers. */
function runnerPatterns(text: string): readonly RegExp[] {
  const names: string[] = [];
  const namespace: string[] = [];
  const imports =
    /\bimport\s+(?:\*\s+as\s+([\w$]+)|\{([^}]+)\})\s+from\s+['"](effect(?:\/Effect)?)['"]/gu;
  for (const match of text.matchAll(imports)) {
    if (match[1] !== undefined && match[3] === 'effect/Effect') namespace.push(match[1]);
    for (const entry of (match[2] ?? '').split(',')) {
      const binding = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/u.exec(entry);
      if (binding === null) continue;
      const local = binding[2] ?? binding[1]!;
      if (match[3] === 'effect' && binding[1] === 'Effect') namespace.push(local);
      if (match[3] === 'effect/Effect' && /^run(?:Promise|Sync|Fork)(?:Exit)?$/u.test(binding[1]!))
        names.push(local);
    }
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [
    ...names.map((name) => new RegExp(String.raw`(?<![.\w$])${escape(name)}\s*\(`, 'gu')),
    ...namespace.map(
      (name) =>
        new RegExp(
          String.raw`\b${escape(name)}\s*\.\s*run(?:Promise|Sync|Fork)(?:Exit)?\s*\(`,
          'gu',
        ),
    ),
  ];
}

/** All matches of one compiled group over the joined text. */
function scan(text: string, patterns: readonly RegExp[], group: Group, found: Match[]): void {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const value = match[0];
      if (value.length > 0)
        found.push({ start: match.index, end: match.index + value.length, text: value, group });
      // A user-supplied pattern may match the empty string; step past it rather than spin.
      if (value.length === 0) pattern.lastIndex += 1;
      match = pattern.exec(text);
    }
  }
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A8/A9/A1: scaffold and generator templates must emit Effect-native browser plumbing. ' +
        'Generated code must not be Promise-first (`async`/`await`/`.then(`/`new Promise(`/`Effect.runPromise`/' +
        '`fetch(`), must not build an HttpApi client inside every operation ' +
        '(`makeEffectHttpApiClient(` / `HttpApiClient.make(` in a function body), and must not declare route ' +
        'parameters as `Readonly<Partial<Record<…, string>>>`. Emit Effect data hooks on the shared browser ' +
        "`ManagedRuntime`, one long-lived client from the runtime's Layer, and Schema route parameters " +
        '(`Schema.standardSchemaV1` over branded identifiers). Lexical static-fragment scan; no generated type/lifetime proof.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a8-fix-the-generators-before-generating-more-code',
    },
    messages: {
      promiseFirst:
        'Audit A8/A9: generated code must not be Promise-first (matched `{{snippet}}` in a generator template). ' +
        "A8 names the generators as the multiplier for A9's ~40 scattered browser `runPromise` seams — every " +
        'generated page inherits this shape. Emit generated Effect data hooks that run on the shared browser ' +
        '`ManagedRuntime` through one query adapter that threads the cancellation signal and preserves the typed ' +
        'failure until the React/TanStack boundary, instead of `async`/`await`/`.then`/`fetch`/`Effect.runPromise` ' +
        'in the emitted module. The Promise adapter React and TanStack force is legitimate once, owned by the ' +
        'browser runtime — not re-emitted into every generated file.',
      perCallClient:
        'Audit A9/A1: this template constructs an HttpApi client inside an operation body (matched ' +
        '`{{snippet}}`), so every generated operation builds a fresh client — A9\'s "fresh clients per ' +
        'operation", multiplied once per generated contribution. Emit one long-lived client built once from the ' +
        "shared runtime's Layer and injected `HttpClient` (`const client = yield* ${Name}Client;`, with " +
        '`Layer.effect(${Name}Client, HttpApiClient.make(${Name}Api))` composed into the browser ' +
        '`ManagedRuntime`), and put per-request headers on the request via middleware rather than by rebuilding ' +
        'the client.',
      routeParams:
        'Audit A8/A9: generated route parameters must be a Schema, not a hand-written type (matched ' +
        '`{{snippet}}`). `Readonly<Partial<Record<…, string>>>` makes every route parameter optional, untyped and ' +
        'unbranded, and A8 lists these "repeated route argument types" as generator debt. Emit ' +
        '`export const ${Name}RouteParams = Schema.Struct({ customerId: CustomerId })` over branded identifier ' +
        'Schemas and expose it through `Schema.standardSchemaV1(${Name}RouteParams)` so the router decodes and ' +
        'validates route and search parameters instead of each generated page re-parsing strings.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          templatePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Repo-relative globs of generator files whose template literals are scanned. Default: scripts/scaffolding/**, scripts/generate-*, **/generators/**, **/codegen/**, **/templates/**, *.template.*.',
          },
          promiseFirstPatterns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Regular-expression sources (compiled with `gu`) for Promise-first emitted code. Replaces the defaults wholesale; `[]` disables the group.',
          },
          perCallClientPatterns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Regular-expression sources for HttpApi client construction in emitted code. Replaces the defaults wholesale; `[]` disables the group.',
          },
          routeParamPatterns: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Regular-expression sources for hand-written route parameter types, scanned only in templates mentioning `RouteParams` or `SearchParams`. Replaces the defaults wholesale; `[]` disables the group.',
          },
          strictPerCallClient: {
            type: 'boolean',
            description:
              'When true, report every emitted HttpApi client construction rather than only those inside a function body (default: false).',
          },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs never scanned (default: build output, node_modules, *.d.ts).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        templatePaths: [...DEFAULT_TEMPLATE_PATHS],
        promiseFirstPatterns: [...DEFAULT_PROMISE_FIRST],
        perCallClientPatterns: [...DEFAULT_PER_CALL_CLIENT],
        routeParamPatterns: [...DEFAULT_ROUTE_PARAMS],
        strictPerCallClient: false,
        exclude: [...DEFAULT_EXCLUDE],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const path = scopePath(context.filename);
    // The scaffold golden-output tests quote the current generator output verbatim; reporting there
    // would double-count every finding, and the audit's D tier blesses hand-written test fixtures.
    if (isTestFile(path)) return {};
    if (!matchesGlobs(path, options.templatePaths)) return {};
    if (matchesGlobs(path, options.exclude)) return {};

    const promiseFirst = compilePatterns(options.promiseFirstPatterns);
    const perCallClient = compilePatterns(options.perCallClientPatterns);
    const routeParams = compilePatterns(options.routeParamPatterns);
    if (promiseFirst.length + perCallClient.length + routeParams.length === 0) return {};

    function inspect(node: StringNode): void {
      if (driverText(node)) return;
      const text = emittedText(node);
      // Single-line package-manager commands are generator instructions, not JS source.
      if (/^\s*(?:pnpm|npm|npx|yarn|bun)\s+[^\r\n]*$/u.test(text)) return;
      const syntax = maskText(text);
      const found: Match[] = [];
      scan(syntax, promiseFirst, 'promiseFirst', found);
      if (
        options.promiseFirstPatterns.includes(
          String.raw`\bEffect\.run(?:Promise|Sync|Fork)(?:Exit)?\b`,
        )
      )
        scan(syntax, runnerPatterns(maskText(text, false)), 'promiseFirst', found);
      const spans = operationSpans(syntax);
      const clients: Match[] = [];
      scan(syntax, perCallClient, 'perCallClient', clients);
      for (const candidate of clients) {
        const enclosing = spans.functions.filter(
          (span) => span.start < candidate.start && span.end > candidate.start,
        );
        const perOperation = enclosing.some(
          (fn) =>
            !spans.layers.some((layer) => layer.start < fn.start && layer.end > candidate.start),
        );
        if (options.strictPerCallClient || perOperation) found.push(candidate);
      }
      if (ROUTE_PARAMS_GATE.test(syntax)) scan(syntax, routeParams, 'routeParams', found);
      found.sort((a, b) => a.start - b.start || b.end - a.end);
      let consumedTo = -1;
      for (const match of found) {
        if (match.start < consumedTo) continue;
        consumedTo = match.end;
        context.report({
          node: reportNode(node, match.start, match.end),
          messageId: match.group,
          data: { snippet: snippetOf(text.slice(match.start, match.end)) },
        });
      }
    }
    return {
      TemplateLiteral: inspect,
      Literal(node) {
        if (typeof node.value === 'string') inspect(node);
      },
    };
  },
});
