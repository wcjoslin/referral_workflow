/**
 * Unit tests for eventService.ts
 *
 * Uses in-memory SQLite to verify event emission and retrieval.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'specialist@specialist.direct' },
  },
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      from_state TEXT,
      to_state TEXT,
      actor TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_workflow_events_entity ON workflow_events (entity_type, entity_id);
    CREATE INDEX idx_workflow_events_type_time ON workflow_events (event_type, created_at);
  `);

  return { db: drizzle(sqlite, { schema }) };
});

import { db } from '../../../src/db';
import { workflowEvents } from '../../../src/db/schema';
import { emitEvent } from '../../../src/modules/analytics/eventService';
import { eq } from 'drizzle-orm';

describe('eventService', () => {
  describe('emitEvent()', () => {
    it('inserts an event with all fields', async () => {
      await emitEvent({
        eventType: 'referral.received',
        entityType: 'referral',
        entityId: 1,
        fromState: undefined,
        toState: 'Received',
        actor: 'system',
        metadata: { sourceMessageId: '<msg-1@test.direct>', referrerAddress: 'dr@hospital.direct' },
      });

      const events = await db.select().from(workflowEvents).where(eq(workflowEvents.entityId, 1));
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.eventType).toBe('referral.received');
      expect(event.entityType).toBe('referral');
      expect(event.entityId).toBe(1);
      expect(event.fromState).toBeNull();
      expect(event.toState).toBe('Received');
      expect(event.actor).toBe('system');
      expect(event.createdAt).toBeInstanceOf(Date);

      const meta = JSON.parse(event.metadata!);
      expect(meta.sourceMessageId).toBe('<msg-1@test.direct>');
      expect(meta.referrerAddress).toBe('dr@hospital.direct');
    });

    it('handles missing optional fields (fromState, toState, metadata)', async () => {
      await emitEvent({
        eventType: 'referral.routing_assessed',
        entityType: 'referral',
        entityId: 99,
        actor: 'system',
      });

      const events = await db.select().from(workflowEvents).where(eq(workflowEvents.entityId, 99));
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.fromState).toBeNull();
      expect(event.toState).toBeNull();
      expect(event.metadata).toBeNull();
    });

    it('stores prior auth events with payer actor', async () => {
      await emitEvent({
        eventType: 'prior_auth.denied',
        entityType: 'priorAuth',
        entityId: 5,
        fromState: 'Submitted',
        toState: 'Denied',
        actor: 'payer:Aetna',
        metadata: { denialReason: 'Not medically necessary', receivedVia: 'sync' },
      });

      const events = await db.select().from(workflowEvents).where(eq(workflowEvents.entityId, 5));
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.entityType).toBe('priorAuth');
      expect(event.actor).toBe('payer:Aetna');

      const meta = JSON.parse(event.metadata!);
      expect(meta.denialReason).toBe('Not medically necessary');
    });

    it('stores skill events with skill actor', async () => {
      await emitEvent({
        eventType: 'skill.evaluated',
        entityType: 'referral',
        entityId: 10,
        actor: 'skill:payer-check',
        metadata: { triggerPoint: 'post-intake', matched: true, confidence: 0.95 },
      });

      const events = await db.select().from(workflowEvents).where(eq(workflowEvents.entityId, 10));
      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe('skill:payer-check');

      const meta = JSON.parse(events[0].metadata!);
      expect(meta.matched).toBe(true);
      expect(meta.confidence).toBe(0.95);
    });

    it('stores multiple events for the same entity', async () => {
      const entityId = 200;

      await emitEvent({
        eventType: 'referral.received',
        entityType: 'referral',
        entityId,
        toState: 'Received',
        actor: 'system',
      });

      await emitEvent({
        eventType: 'referral.acknowledged',
        entityType: 'referral',
        entityId,
        fromState: 'Received',
        toState: 'Acknowledged',
        actor: 'system',
      });

      await emitEvent({
        eventType: 'referral.accepted',
        entityType: 'referral',
        entityId,
        fromState: 'Acknowledged',
        toState: 'Accepted',
        actor: 'clinician:dr-smith',
      });

      const events = await db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.entityId, entityId));
      expect(events).toHaveLength(3);

      const types = events.map((e) => e.eventType);
      expect(types).toContain('referral.received');
      expect(types).toContain('referral.acknowledged');
      expect(types).toContain('referral.accepted');
    });
  });
});
