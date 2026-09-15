CREATE TABLE `comment_mentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` integer NOT NULL,
	`revision_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`mentioned_user_id` integer,
	`mentioned_party_id` integer,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`acknowledged_by_actor` text,
	FOREIGN KEY (`comment_id`) REFERENCES `referral_comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `comment_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mentioned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mentioned_party_id`) REFERENCES `workspace_parties`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comment_mentions_target_union" CHECK(("comment_mentions"."mentioned_user_id" IS NULL) <> ("comment_mentions"."mentioned_party_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_comment_mentions_workspace` ON `comment_mentions` (`workspace_id`,`acknowledged_at`);--> statement-breakpoint
CREATE INDEX `idx_comment_mentions_user` ON `comment_mentions` (`mentioned_user_id`,`acknowledged_at`);--> statement-breakpoint
CREATE TABLE `comment_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` integer NOT NULL,
	`revision_number` integer NOT NULL,
	`body` text NOT NULL,
	`visibility` text DEFAULT 'Internal' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_actor` text NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`comment_id`) REFERENCES `referral_comments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comment_revisions_number` ON `comment_revisions` (`comment_id`,`revision_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comment_revisions_current` ON `comment_revisions` (`comment_id`) WHERE "comment_revisions"."superseded_at" IS NULL;--> statement-breakpoint
CREATE TABLE `referral_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`author_user_id` integer,
	`author_guest_id` integer,
	`author_party_id` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_actor` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_guest_id`) REFERENCES `workspace_guests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_party_id`) REFERENCES `workspace_parties`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "referral_comments_author_union" CHECK(("referral_comments"."author_user_id" IS NULL) <> ("referral_comments"."author_guest_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_referral_comments_workspace` ON `referral_comments` (`workspace_id`,`created_at`);