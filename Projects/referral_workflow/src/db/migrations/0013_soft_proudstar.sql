CREATE TABLE `party_addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`party_id` integer NOT NULL,
	`address` text NOT NULL,
	`address_kind` text,
	`first_seen_message_id` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `workspace_parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_seen_message_id`) REFERENCES `referral_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_party_addresses_party` ON `party_addresses` (`party_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_party_addresses_unique` ON `party_addresses` (`workspace_id`,lower("address"));--> statement-breakpoint
CREATE TABLE `workspace_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`added_by_user_id` integer,
	`added_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`added_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_participants_workspace` ON `workspace_participants` (`workspace_id`,`removed_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_participants_user` ON `workspace_participants` (`user_id`,`removed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_participants_unique` ON `workspace_participants` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspace_parties` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`org_name` text,
	`org_name_verified` integer DEFAULT false NOT NULL,
	`direct_address` text,
	`party_role` text NOT NULL,
	`protocol_mode` text DEFAULT 'local-only' NOT NULL,
	`protocol_mode_set_by` text,
	`protocol_mode_set_at` integer,
	`capability_verified_at` integer,
	`contact_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_parties_workspace` ON `workspace_parties` (`workspace_id`,`party_role`);--> statement-breakpoint
CREATE INDEX `idx_workspace_parties_address` ON `workspace_parties` (lower("direct_address"));