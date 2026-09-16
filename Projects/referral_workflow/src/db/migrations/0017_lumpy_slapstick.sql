CREATE TABLE `document_access_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`viewer_user_id` integer,
	`viewer_guest_id` integer,
	`action` text NOT NULL,
	`reason` text,
	`viewed_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `workspace_documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`viewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`viewer_guest_id`) REFERENCES `workspace_guests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_document_access_document` ON `document_access_log` (`document_id`,`viewed_at`);--> statement-breakpoint
CREATE TABLE `workspace_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`content_source` text NOT NULL,
	`content_ref` integer,
	`upload_path` text,
	`content_type` text NOT NULL,
	`claimed_content_type` text,
	`doc_type` text NOT NULL,
	`loinc_code` text,
	`protocol_relationship` text,
	`source` text NOT NULL,
	`scope` text DEFAULT 'referral' NOT NULL,
	`sender_party_id` integer,
	`sender_address` text,
	`received_at` integer NOT NULL,
	`visibility` text DEFAULT 'Internal' NOT NULL,
	`delivery_mode` text,
	`immutable` integer DEFAULT true NOT NULL,
	`sha256` text,
	`original_filename` text,
	`uploaded_by_user_id` integer,
	`uploaded_by_guest_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_party_id`) REFERENCES `workspace_parties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_guest_id`) REFERENCES `workspace_guests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_documents_workspace` ON `workspace_documents` (`workspace_id`,`received_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_documents_source` ON `workspace_documents` (`workspace_id`,`content_source`,`content_ref`);