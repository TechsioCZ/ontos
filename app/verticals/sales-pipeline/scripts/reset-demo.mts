// Sales-demo owner seed for demo.sales-pipeline (placeholder).
// Contract: app/scripts/demo/reset-demo.mts spawns this script with `--sales-demo`, DATABASE_ADMIN_URL
// and DEMO_RESET_PROFILE=sales in the environment, in a fixed owner order. Build deterministic IDs with
// demoId() from app/scripts/demo/fixture-ids.mts and write only this vertical's own schema.
// The siampark-billing-finance owner reset script shows a complete owner-state writer.
import { NodeRuntime } from '@effect/platform-node';
import { Console } from 'effect';

NodeRuntime.runMain(Console.log('sales-pipeline: no sales-demo seed yet'));
