CREATE TABLE `workspace_guests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invitation_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`party_id` integer NOT NULL,
	`display_name` text,
	`session_token_hash` text,
	`session_expires_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `workspace_invitations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `workspace_parties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_guests_workspace` ON `workspace_guests` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_guests_session` ON `workspace_guests` (`session_token_hash`);--> statement-breakpoint
CREATE TABLE `workspace_invitations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`party_id` integer NOT NULL,
	`recipient_email` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`revoked_by_user_id` integer,
	`superseded_by_id` integer,
	`email_delivered` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`party_id`) REFERENCES `workspace_parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_token_hash_unique` ON `workspace_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_workspace_invitations_workspace` ON `workspace_invitations` (`workspace_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_invitations_token` ON `workspace_invitations` (`token_hash`);