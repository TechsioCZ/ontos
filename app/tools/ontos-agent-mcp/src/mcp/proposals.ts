import { z } from 'zod';
import { OntosRequestError } from '../ontos-client.ts';
import { CONNECTOR_KEY_HEADER, CONNECTOR_PATHS } from '../oauth/types.ts';
import type { PrincipalSession } from '../session.ts';

export interface ProposalDiffLine {
  readonly field: string;
  readonly label: string;
  readonly before?: string;
  readonly after?: string;
}
export interface ProposalInput {
  readonly appId: string;
  readonly actionSlug: string;
  readonly command: Readonly<Record<string, unknown>>;
  readonly diff: readonly ProposalDiffLine[];
  readonly reason: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly summary: string;
  readonly targetLabel: string;
}
export interface SubmitProposalsRequest {
  readonly agentLabel?: string;
  readonly instruction: string;
  readonly legalEntityId: string;
  readonly proposals: readonly ProposalInput[];
  readonly runId?: string;
}
export const SubmitProposalsResponseSchema = z.object({
  batchId: z.string(),
  proposalIds: z.array(z.string()),
  replayed: z.boolean(),
  reviewPath: z.string(),
});
export type SubmitProposalsResponse = z.infer<typeof SubmitProposalsResponseSchema>;
export const ProposalQueueSchema = z.object({
  batches: z.array(
    z.object({
      batchId: z.string(),
      createdAt: z.string(),
      instruction: z.string(),
      items: z.array(z.object({ status: z.string(), summary: z.string(), targetLabel: z.string() })),
    }),
  ),
  pendingCount: z.number(),
});
export type ProposalQueue = z.infer<typeof ProposalQueueSchema>;

/** The approvals endpoint is not deployed yet (404/405): callers fall back to the module's AiProposeChanges. */
export class ProposalsEndpointMissingError extends Error {
  override readonly name = 'ProposalsEndpointMissingError';
}

export interface ProposalsTarget {
  readonly shellUrl: string;
  readonly session: PrincipalSession;
  readonly fetchFn?: typeof fetch | undefined;
}

/** OAuth: connector headers (design §6). stdio: the environment API key. */
export const proposalHeaders = (session: PrincipalSession): Record<string, string> =>
  session.kind === 'oauth_connection'
    ? {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
        [CONNECTOR_KEY_HEADER]: session.connectorSecret,
      }
    : { 'content-type': 'application/json', 'x-api-key': session.apiKey };

const post = async (target: ProposalsTarget, path: string, body: unknown, failureCs: string): Promise<unknown> => {
  const response = await (target.fetchFn ?? fetch)(`${target.shellUrl}${path}`, {
    body: JSON.stringify(body),
    headers: proposalHeaders(target.session),
    method: 'POST',
  });
  if (response.status === 404 || response.status === 405) {
    throw new ProposalsEndpointMissingError(`HTTP ${response.status}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let problem: { code?: unknown; detail?: unknown; title?: unknown } = {};
    try {
      problem = JSON.parse(text) as typeof problem;
    } catch {
      problem = {};
    }
    const field = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() !== '' ? value : undefined;
    const code = field(problem.code);
    const detail = field(problem.detail);
    const title = field(problem.title);
    throw new OntosRequestError({
      ...(code === undefined ? {} : { code }),
      ...(detail === undefined ? {} : { detail }),
      message: `${failureCs} (HTTP ${response.status})`,
      status: response.status,
      ...(title === undefined ? {} : { title }),
    });
  }
  return JSON.parse(text) as unknown;
};

export const submitProposals = async (
  target: ProposalsTarget,
  body: SubmitProposalsRequest,
): Promise<SubmitProposalsResponse> =>
  SubmitProposalsResponseSchema.parse(await post(target, CONNECTOR_PATHS.proposals, body, 'Návrh se nepodařilo uložit'));

export const listProposals = async (target: ProposalsTarget, legalEntityId: string): Promise<ProposalQueue> =>
  ProposalQueueSchema.parse(
    await post(target, CONNECTOR_PATHS.proposalsList, { legalEntityId }, 'Návrhy se nepodařilo načíst'),
  );
