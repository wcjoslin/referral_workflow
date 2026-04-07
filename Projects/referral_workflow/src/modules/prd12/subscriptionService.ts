/**
 * PRD-12 Subscription Service
 *
 * Manages rest-hook subscription lifecycle for pended prior authorization requests.
 * Registers subscriptions with the mock payer and handles $inquire polling fallback.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { priorAuthRequests } from '../../db/schema';
import * as pasClient from './pasClient';
import { config } from '../../config';

/**
 * Registers a rest-hook subscription with the mock payer for a pended PA request.
 * Stores the subscription ID on the request record.
 */
export async function registerPendedSubscription(
  requestId: number,
  claimId: string,
  patientId: string,
): Promise<void> {
  const port = config.server.port;
  const webhookUrl = `http://localhost:${port}/prior-auth/webhook`;

  try {
    const subscriptionId = await pasClient.registerSubscription(webhookUrl, claimId, patientId);

    if (subscriptionId) {
      await db
        .update(priorAuthRequests)
        .set({ subscriptionId, updatedAt: new Date() })
        .where(eq(priorAuthRequests.id, requestId));

      console.log(`[Subscription] Registered subscription ${subscriptionId} for PA request ${requestId}`);
    } else {
      console.warn(`[Subscription] Failed to register subscription for PA request ${requestId}`);
    }
  } catch (err) {
    console.warn(
      `[Subscription] Error registering subscription for PA request ${requestId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
