CREATE TABLE `referral_workspaces` (
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
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_workspaces_referral_id_unique` ON `referral_workspaces` (`referral_id`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_referral` ON `referral_workspaces` (`referral_id`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_owner` ON `referral_workspaces` (`owner_user_id`,`work_status`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_queue` ON `referral_workspaces` (`queue_id`,`work_status`);--> statement-breakpoint
CREATE INDEX `idx_referral_workspaces_due` ON `referral_workspaces` (`next_action_due_at`);