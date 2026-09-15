CREATE TABLE `workspace_assertions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`assertion_key` text NOT NULL,
	`assertion_type` text NOT NULL,
	`asserted_by_party_id` integer NOT NULL,
	`asserted_by_actor` text NOT NULL,
	`context` text,
	`from_state` text,
	`to_state` text,
	`artifact_message_id` integer,
	`delivery_mode` text NOT NULL,
	`transport_mode` text NOT NULL,
	`sent_to_address` text,
	`sent_from_address` text,
	`address_matched_on` text,
	`delivery_status` text DEFAULT 'Pending' NOT NULL,
	`delivery_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asserted_by_party_id`) REFERENCES `workspace_parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_message_id`) REFERENCES `referral_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_assertions_assertion_key_unique` ON `workspace_assertions` (`assertion_key`);--> statement-breakpoint
CREATE INDEX `idx_workspace_assertions_workspace` ON `workspace_assertions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_assertions_key` ON `workspace_assertions` (`assertion_key`);