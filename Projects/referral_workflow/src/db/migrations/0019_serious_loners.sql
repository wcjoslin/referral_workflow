-- PRD-20: adds the real FOREIGN KEY on referral_workspaces.queue_id, which
-- PRD-18 left as a plain integer. SQLite cannot add a constraint in place, so
-- drizzle-kit recreates the table.
--
-- HAND-EDITED, DELIBERATELY. drizzle-kit generated `PRAGMA foreign_keys=OFF`
-- here. That pragma is a NO-OP inside a transaction, and drizzle's migrator
-- runs every migration in one, so foreign keys stayed ON and the DROP TABLE
-- below failed against the nine tables that reference referral_workspaces.
-- Verified: it applies on an empty database and fails on a populated one, i.e.
-- it would have passed CI and broken the demo database.
--
-- `defer_foreign_keys` DOES work inside a transaction: enforcement moves to
-- COMMIT, by which point the table has been recreated and every child row
-- resolves again. Verified on a populated database -- row values identical,
-- child rows preserved, all nine child foreign keys intact, foreign_key_check
-- empty, integrity_check ok, all five indexes recreated.
--
-- If drizzle-kit ever recreates a table again, it will emit foreign_keys=OFF
-- and reintroduce the bug. tests/dbMigrations.test.ts fails if it does.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_referral_workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`referral_id` integer NOT NULL,
	`external_referral_id` text,
	`correlation_key` text,
	`work_status` text DEFAULT 'Triage' NOT NULL,
	`work_status_is_manual` integer DEFAULT false NOT NULL,
	`work_status_set_by` text,
	`work_status_set_at` integer,
	`owner_user_id` integer,
	`queue_id` integer,
	`next_action` text,
	`next_action_due_at` integer,
	`exception_reason` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`queue_id`) REFERENCES `queues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_referral_workspaces`("id", "referral_id", "external_referral_id", "correlation_key", "work_status", "work_status_is_manual", "work_status_set_by", "work_status_set_at", "owner_user_id", "queue_id", "next_action", "next_action_due_at", "exception_reason", "archived_at", "created_at", "updated_at") SELECT "id", "referral_id", "external_referral_id", "correlation_key", "work_status", "work_status_is_manual", "work_status_set_by", "work_status_set_at", "owner_user_id", "queue_id", "next_action", "next_action_due_at", "exception_reason", "archived_at", "created_at", "updated_at" FROM `referral_workspaces`;--> statement-breakpoint
DROP TABLE `referral_workspaces`;--> statement-breakpoint
ALTER TABLE `__new_referral_workspaces` RENAME TO `referral_workspaces`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `referral_workspaces_referral_id_unique` ON `referral_workspaces` (`referral_id`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_referral` ON `referral_workspaces` (`referral_id`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_owner` ON `referral_workspaces` (`owner_user_id`,`work_status`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_queue` ON `referral_workspaces` (`queue_id`,`work_status`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_due` ON `referral_workspaces` (`next_action_due_at`);