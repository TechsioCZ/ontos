// @effect-diagnostics processEnv:off
import { and, eq } from 'drizzle-orm';
import { APIError, BASE_ERROR_CODES, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import { authTables } from '../db/auth-schema.ts';
import { db } from '../db/client.ts';
import { principalAuthBindings, principals, tenants } from '../db/schema.ts';

const baseUrl = process.env['BETTER_AUTH_URL']?.trim() || 'http://localhost:3020';
const secret = process.env['BETTER_AUTH_SECRET']?.trim() || 'app-local-better-auth-secret-32-bytes';

const hasActivePrincipalBinding = (userId: string) =>
  db
    .select({
      principalAuthBindingId: principalAuthBindings.principalAuthBindingId,
    })
    .from(principalAuthBindings)
    .innerJoin(principals, eq(principalAuthBindings.principalId, principals.principalId))
    .innerJoin(tenants, eq(principalAuthBindings.tenantId, tenants.tenantId))
    .where(
      and(
        eq(principalAuthBindings.provider, 'better_auth'),
        eq(principalAuthBindings.subjectType, 'user'),
        eq(principalAuthBindings.providerSubjectId, userId),
        eq(principalAuthBindings.status, 'active'),
        eq(principals.status, 'active'),
        eq(tenants.status, 'active'),
      ),
    )
    .limit(1)
    .then(([binding]) => binding !== undefined);

export const auth = betterAuth({
  basePath: '/shell-super-app-api/auth',
  baseURL: baseUrl,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: authTables,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  plugins: [
    {
      hooks: {
        after: [
          {
            handler: createAuthMiddleware((ctx) => {
              const newSession = ctx.context.newSession;

              if (newSession === undefined || newSession === null) {
                return Promise.resolve();
              }

              return hasActivePrincipalBinding(newSession.user.id).then((hasBinding) => {
                if (hasBinding) {
                  return;
                }

                return ctx.context.internalAdapter
                  .deleteUserSessions(newSession.user.id)
                  .then(() => {
                    deleteSessionCookie(ctx);
                    throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
                  });
              });
            }),
            matcher: (ctx) => ctx.path === '/sign-in/email',
          },
          {
            handler: createAuthMiddleware((ctx) => {
              const returned = ctx.context.returned as
                | {
                    session?: { token?: string };
                    user?: { id?: string };
                  }
                | null
                | undefined;
              const userId = returned?.user?.id;
              const sessionToken = returned?.session?.token;

              if (userId === undefined || sessionToken === undefined) {
                return Promise.resolve();
              }

              return hasActivePrincipalBinding(userId).then((hasBinding) => {
                if (hasBinding) {
                  return;
                }

                return ctx.context.internalAdapter.deleteSession(sessionToken).then(() => {
                  deleteSessionCookie(ctx);

                  return ctx.json(null);
                });
              });
            }),
            matcher: (ctx) => ctx.path === '/get-session',
          },
        ],
      },
      id: 'ontos-authenticated-principal-session',
    },
  ],
  secret,
  trustedOrigins: [baseUrl],
});
