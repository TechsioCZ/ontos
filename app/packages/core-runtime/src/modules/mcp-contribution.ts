/**
 * MCP tool contributions of a MicroVertical (`publicSurface.mcp`).
 *
 * A vertical authors {@link OntosMcpContributionInput} next to its manifest: module texts, which reads, commands
 * and named Actions agents may use, and their Czech/English titles. The module contract generator turns it into the
 * serialized {@link OntosMcpContribution}, adding JSON Schemas derived from the vertical's own Effect Schemas and
 * the HTTP path of each handler on the vertical's BFF. The Shell aggregates the contributions of the active
 * composition at runtime; Core and the Shell never name a vertical, a tool or a schema.
 */
import { Predicate, Schema } from 'effect';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

export const OntosMcpTextSchema = Schema.Struct({
  cs: nonEmpty.check(Schema.isMaxLength(400)),
  en: nonEmpty.check(Schema.isMaxLength(400)),
});
export type OntosMcpText = typeof OntosMcpTextSchema.Type;

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

/** Where a command's optimistic-concurrency revision lives in the answer of one read. */
export const OntosMcpRevisionSchema = Schema.Struct({
  /** Dot path of the revision in the read answer when no prefix matches, e.g. `revision`. */
  field: nonEmpty,
  /** Commands whose tag starts with `prefix` read their revision at `field` instead (per-agenda revisions). */
  fieldsByCommandPrefix: Schema.Array(Schema.Struct({ field: nonEmpty, prefix: nonEmpty })),
  /** Path of the read on the vertical BFF, e.g. `/reads/records`. */
  path: nonEmpty,
  /** JSON body of the read. */
  query: JsonObjectSchema,
});
export type OntosMcpRevision = typeof OntosMcpRevisionSchema.Type;

export const OntosMcpToolSchema = Schema.Struct({
  /** Required module access: `read` for reads, `write` for commands and Actions. */
  access: Schema.Literals(['read', 'write']),
  /** An agent acting on its own may only propose this change for approval, never run it directly. */
  agentProposalOnly: Schema.Boolean,
  description: Schema.optionalKey(OntosMcpTextSchema),
  /** Removes, cancels or voids data or access; clients ask before calling. */
  destructive: Schema.Boolean,
  /** Stable id: `<moduleId>/read/<slug>`, `<moduleId>/command/<Tag>` or `<moduleId>/action/<slug>`. */
  id: nonEmpty,
  /** JSON Schema of the tool arguments; `$ref`s point into the contribution's `definitions`. */
  inputSchema: JsonObjectSchema,
  /**
   * Handler on the vertical BFF (`path` relative to `/<appId>-api`). With `commandTag` the arguments are wrapped as
   * `{ command: { _tag, ...arguments }, expectedRevision }`; otherwise they are posted as they are.
   */
  invoke: Schema.Struct({ commandTag: Schema.optionalKey(nonEmpty), path: nonEmpty }),
  /** Flag of the revision read answer that must not be `false` for the person to run this directly. */
  liveRight: Schema.optionalKey(nonEmpty),
  /** MCP tool name, `^[a-z0-9_]{1,64}$`. */
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,64}$/u)),
  /** Other deployment app ids whose gateway assertions the handler needs as reference credentials. */
  referenceAudiences: Schema.Array(nonEmpty),
  title: OntosMcpTextSchema,
});
export type OntosMcpTool = typeof OntosMcpToolSchema.Type;

/**
 * The module's agent review read (`@app/shared-contracts/agent-review`): the approval platform asks it, as the
 * reading person, whether a proposal is visible to them, whether they can carry it out, its before -> after lines,
 * its undo plan and its follow-up after approval. Modules without it get the platform's generic handling.
 */
export const OntosMcpApprovalReviewSchema = Schema.Struct({
  /** Path of the read on the vertical BFF, e.g. `/reads/agent-review`. */
  path: nonEmpty,
  /** Records are private per person: when the review read is unavailable, the module's proposals stay hidden. */
  privateRecords: Schema.Boolean,
});
export type OntosMcpApprovalReview = typeof OntosMcpApprovalReviewSchema.Type;

export const OntosMcpContributionSchema = Schema.Struct({
  approvalReview: Schema.optionalKey(OntosMcpApprovalReviewSchema),
  /** Proposals for this module may go to the platform approval queue („Ke schválení“). */
  approvals: Schema.Boolean,
  /** Shared JSON Schema definitions of the tools (`#/$defs/<key>`). */
  definitions: Schema.Record(Schema.String, Schema.Json),
  description: OntosMcpTextSchema,
  /** Search words (Czech and English) for capability search. */
  keywords: Schema.String.check(Schema.isMaxLength(2000)),
  label: OntosMcpTextSchema,
  /**
   * Company-wide (Legal Entity) authorization relations an agent with write access to this module receives from the
   * company's role templates, because the module's Actions check them (e.g. a manager relation).
   */
  legalEntityWriteRelations: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/u))),
  ),
  /** The module keeps its own AI change engine (`aiChanges`, AiDecideChanges, AiRevertBatch) the queue also shows. */
  ownProposalEngine: Schema.optionalKey(Schema.Boolean),
  /** Shell page of the module below `/<lang>`, e.g. `/ukoly`. */
  page: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\/[a-z0-9/-]*$/u))),
  revision: Schema.optionalKey(OntosMcpRevisionSchema),
  tools: Schema.Array(OntosMcpToolSchema),
});
export type OntosMcpContribution = typeof OntosMcpContributionSchema.Type;

/** Title and optional description of one tool, authored by the vertical. */
export interface OntosMcpToolTextInput {
  readonly description?: OntosMcpText;
  readonly title: OntosMcpText;
}

/** A command or named Action offered as a write tool. */
export interface OntosMcpWriteInput extends OntosMcpToolTextInput {
  readonly agentProposalOnly?: boolean;
  readonly destructive?: boolean;
  readonly liveRight?: string;
  readonly referenceAudiences?: readonly string[];
}

/** Explicitly not offered to agents (approval plumbing, demo maintenance, internal recovery). */
export const OntosMcpHidden = 'hidden' as const;
export type OntosMcpHidden = typeof OntosMcpHidden;

/**
 * What a vertical authors. Every read (`/reads/<slug>` of its public APIs), every variant of a command-union Action
 * and every other public Action must appear in `reads`, `commands` or `actions`, either with texts or as
 * {@link OntosMcpHidden}; the contract generator fails otherwise.
 */
export interface OntosMcpContributionInput {
  readonly actions?: Readonly<Record<string, OntosMcpWriteInput | OntosMcpHidden>>;
  /** Read slug of the module's agent review read (see {@link OntosMcpApprovalReviewSchema}). */
  readonly approvalReview?: { readonly privateRecords?: boolean; readonly read: string };
  readonly approvals: boolean;
  readonly commands?: Readonly<Record<string, OntosMcpWriteInput | OntosMcpHidden>>;
  readonly description: OntosMcpText;
  readonly keywords: string;
  readonly label: OntosMcpText;
  /** See {@link OntosMcpContributionSchema} `legalEntityWriteRelations`. */
  readonly legalEntityWriteRelations?: readonly string[];
  readonly ownProposalEngine?: boolean;
  readonly page?: string;
  readonly reads: Readonly<Record<string, OntosMcpToolTextInput | OntosMcpHidden>>;
  readonly revision?: {
    readonly field?: string;
    readonly fieldsByCommandPrefix?: readonly { readonly field: string; readonly prefix: string }[];
    readonly query?: Readonly<Record<string, Schema.Json>>;
    /** Read slug, e.g. `records`. */
    readonly read: string;
  };
}

const isText = (value: unknown): value is OntosMcpText =>
  Predicate.isObject(value) &&
  Predicate.isString(Reflect.get(value, 'cs')) &&
  Predicate.isString(Reflect.get(value, 'en')) &&
  Reflect.get(value, 'cs') !== '' &&
  Reflect.get(value, 'en') !== '';

class OntosMcpContributionError extends Schema.TaggedError<OntosMcpContributionError>()('OntosMcpContributionError', {
  message: Schema.String,
}) {}

/** Checks the authored texts early (at import), so a missing title fails the vertical's own tests. */
export const defineOntosMcpContribution = <const Input extends OntosMcpContributionInput>(input: Input): Input => {
  const fail = (message: string): never => {
    throw new OntosMcpContributionError({ message });
  };
  if (!isText(input.label) || !isText(input.description)) {
    fail('MCP contribution needs Czech and English label and description');
  }
  for (const [group, entries] of [
    ['reads', input.reads],
    ['commands', input.commands ?? {}],
    ['actions', input.actions ?? {}],
  ] as const) {
    for (const [key, entry] of Object.entries(entries)) {
      if (entry !== OntosMcpHidden && !isText(entry.title)) {
        fail(`MCP ${group}.${key} needs a Czech and English title`);
      }
      if (entry !== OntosMcpHidden && entry.description !== undefined && !isText(entry.description)) {
        fail(`MCP ${group}.${key} description needs Czech and English text`);
      }
    }
  }
  if (input.approvalReview !== undefined && !(input.approvalReview.read in input.reads)) {
    fail(`MCP approval review read ${input.approvalReview.read} is not one of the module's reads`);
  }
  if (input.approvalReview !== undefined && !input.approvals) {
    fail('MCP approval review needs approvals');
  }
  if (input.revision !== undefined && !(input.revision.read in input.reads)) {
    fail(`MCP revision read ${input.revision.read} is not one of the module's reads`);
  }
  return Object.freeze(input);
};
