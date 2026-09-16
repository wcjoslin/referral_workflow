CREATE TABLE `notification_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`notification_type` text NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`email_enabled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_notification_prefs_user` ON `notification_preferences` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_prefs_unique` ON `notification_preferences` (`user_id`,`notification_type`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient_user_id` integer,
	`recipient_guest_id` integer,
	`workspace_id` integer NOT NULL,
	`notification_type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link_path` text NOT NULL,
	`triggered_by_actor` text,
	`collapse_key` text,
	`collapsed_count` integer DEFAULT 1 NOT NULL,
	`email_sent_at` integer,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_guest_id`) REFERENCES `workspace_guests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_recipient_union" CHECK(("notifications"."recipient_user_id" IS NULL) <> ("notifications"."recipient_guest_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_user` ON `notifications` (`recipient_user_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_guest` ON `notifications` (`recipient_guest_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_collapse` ON `notifications` (`collapse_key`,`created_at`);