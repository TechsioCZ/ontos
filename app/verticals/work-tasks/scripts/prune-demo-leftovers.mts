/**
 * Removes rehearsal leftovers from the demo task lists, so a presenter never scrolls past them. LOCAL DEMO ONLY.
 *
 *   node --env-file=.env verticals/work-tasks/scripts/prune-demo-leftovers.mts           # dry run, lists matches
 *   node --env-file=.env verticals/work-tasks/scripts/prune-demo-leftovers.mts --apply   # removes them
 *
 * Only CANCELLED tasks are touched, in every company:
 *   - AI level B proof tasks (`pnpm demo:prove:ai`, auditors): every run leaves one cancelled task, which the proof
 *     hides from the lists (SetTaskArchived). The newest one stays stored, so its direct link still shows what agent B
 *     created.
 *   - QA tasks whose title ends in a random five-character suffix such as `YZ1B8`.
 *   - Tasks with an implausible due date (before 2000, e.g. a typed year 0026).
 * Each company row is rewritten in one UPDATE that bumps its revision, so open clients get a revision conflict and
 * reload instead of writing the old list back. Core audit events of the removed tasks stay untouched.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { Command, Flag } from 'effect/unstable/cli';

// This SQL wire projection retains invalid legacy date text; null covers an absent or JSON-null date value.
// The decoded contract uses Option, while SQL reads its Encoded side without parsing or normalizing dates.
const LeftoverRowSchema = Schema.Struct({
  dueDate: Schema.OptionFromNullOr(Schema.String),
  legalEntityId: Schema.String.pipe(Schema.brand('LegalEntityId')),
  title: Schema.String,
});

const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* connect() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));

const proofTitle = 'AI: zavolat zákazníkovi kvůli nabídce (%';
const proofDescription = 'Vytvořil AI agent úrovně B (%';

const prune = Effect.fn('Work.pruneDemoLeftovers')(function* prune(apply: boolean) {
  const sql = yield* PgClient.PgClient;
  // `t` is one task of row `ws`; `newest` is the createdAt of that row's newest proof task.
  const isLeftover = sql.unsafe(`(
    t->>'state' = 'CANCELLED' and (
      (t->>'title' like '${proofTitle}' and t->>'description' like '${proofDescription}'
        and t->>'createdAt' < coalesce((
          select max(p->>'createdAt') from jsonb_array_elements(ws.state->'tasks') p
          where p->>'title' like '${proofTitle}' and p->>'description' like '${proofDescription}'
        ), ''))
      or (t->>'title' ~ ' [A-Z0-9]{5}$' and right(t->>'title', 5) ~ '[0-9]' and right(t->>'title', 5) ~ '[A-Z]')
      or coalesce(t->>'dueDate', '9999-12-31') < '2000-01-01'
    )
  )`);
  const matches = yield* sql<typeof LeftoverRowSchema.Encoded>`
    select ws.legal_entity_id as "legalEntityId", t->>'title' as title, t->>'dueDate' as "dueDate"
    from work_tasks.work_states ws, jsonb_array_elements(ws.state->'tasks') t
    where ${isLeftover}
    order by 1, 2`;
  for (const match of matches) {
    yield* Console.log(`${match.legalEntityId}  ${match.dueDate ?? '—'}  ${match.title}`);
  }
  if (!apply) {
    return yield* Console.log(`${matches.length} leftover task(s) found; dry run, nothing changed (use --apply).`);
  }
  const updated = yield* sql<{ legalEntityId: string; revision: number; tasks: number }>`
    update work_tasks.work_states ws
    set state = jsonb_set(ws.state, '{tasks}', coalesce((
          select jsonb_agg(t order by position)
          from jsonb_array_elements(ws.state->'tasks') with ordinality as kept(t, position)
          where not ${isLeftover}
        ), '[]'::jsonb)),
        revision = ws.revision + 1,
        updated_at = now()
    where exists (select 1 from jsonb_array_elements(ws.state->'tasks') t where ${isLeftover})
    returning ws.legal_entity_id as "legalEntityId", ws.revision, jsonb_array_length(ws.state->'tasks') as tasks`;
  for (const row of updated) {
    yield* Console.log(`${row.legalEntityId}: ${row.tasks} tasks left, revision ${row.revision}`);
  }
  return yield* Console.log(`${matches.length} leftover task(s) removed.`);
});

const command = Command.make(
  'prune-demo-leftovers',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) => prune(apply).pipe(Effect.provide(admin)),
);

NodeRuntime.runMain(Command.run(command, { version: '0.1.0' }).pipe(Effect.provide(NodeServices.layer)));
