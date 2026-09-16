CREATE TABLE `queue_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`queue_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`access_level` text DEFAULT 'member' NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`queue_id`) REFERENCES `queues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_queue_members_queue` ON `queue_members` (`queue_id`);--> statement-breakpoint
CREATE INDEX `idx_queue_members_user` ON `queue_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_members_unique` ON `queue_members` (`queue_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `queues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`department_filter` text,
	`is_default` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queues_slug_unique` ON `queues` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_queues_slug` ON `queues` (`slug`);--> statement-breakpoint
CREATE TABLE `saved_filters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`surface` text DEFAULT 'queue' NOT NULL,
	`filters_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_saved_filters_user` ON `saved_filters` (`user_id`,`surface`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_filters_name` ON `saved_filters` (`user_id`,`surface`,`name`);