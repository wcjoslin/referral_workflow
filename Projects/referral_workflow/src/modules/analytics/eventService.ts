/**
 * Workflow Event Service
 *
 * Centralised event emission for the unified analytics event log.
 * All workflow events (state transitions, skill evaluations, messages,
 * prior-auth decisions) are recorded via emitEvent().
 *
 * Callers use fire-and-forget:
 *   void emitEvent({ ... }).catch(err => console.error('[EventService]', err));
 */

import { db } from '../../db';
import { workflowEvents } from '../../db/schema';

export interface WorkflowEvent {
  eventType: string;
  entityType: 'referral' | 'priorAuth';
  entityId: number;
  fromState?: string;
  toState?: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

export async function emitEvent(event: WorkflowEvent): Promise<void> {
  await db.insert(workflowEvents).values({
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    fromState: event.fromState ?? null,
    toState: event.toState ?? null,
    actor: event.actor,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    createdAt: new Date(),
  });
}
