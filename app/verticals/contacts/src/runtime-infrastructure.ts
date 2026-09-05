import { DatabaseConfig, loadDatabaseConfig } from '@app/core-runtime';
import { Layer } from 'effect';
import { GatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption-runtime.ts';
import { ContactsDatabaseLive } from './db/client.ts';

/** Contacts deployment composition keeps its scoped database service owner-private. */
const contactsDatabaseLive = ContactsDatabaseLive.pipe(
  Layer.provide(Layer.effect(DatabaseConfig, loadDatabaseConfig())),
);

export const ContactsGatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(contactsDatabaseLive),
);
