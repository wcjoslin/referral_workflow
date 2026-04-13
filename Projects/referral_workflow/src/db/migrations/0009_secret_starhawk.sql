CREATE TABLE `workflow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`from_state` text,
	`to_state` text,
	`actor` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_events_entity` ON `workflow_events` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_events_type_time` ON `workflow_events` (`event_type`,`created_at`);