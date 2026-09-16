CREATE TABLE `auto_declined_referrals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_message_id` text NOT NULL,
	`referrer_address` text NOT NULL,
	`patient_name` text,
	`patient_dob` text,
	`decline_reasons` text NOT NULL,
	`raw_ccda_xml` text,
	`converted_referral_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`converted_referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auto_declined_referrals_source_message_id_unique` ON `auto_declined_referrals` (`source_message_id`);--> statement-breakpoint
CREATE INDEX `idx_auto_declined_created` ON `auto_declined_referrals` (`created_at`);--> statement-breakpoint
CREATE TABLE `processed_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`sender_address` text,
	`subject` text,
	`outcome` text NOT NULL,
	`referral_id` integer,
	`exception_id` integer,
	`processed_at` integer NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processed_messages_message_id_unique` ON `processed_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_processed_messages_message` ON `processed_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_processed_messages_outcome` ON `processed_messages` (`outcome`,`processed_at`);--> statement-breakpoint
CREATE TABLE `workspace_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer,
	`exception_type` text NOT NULL,
	`summary` text NOT NULL,
	`remediation` text,
	`raw_content` text,
	`raw_content_type` text,
	`sender_address` text,
	`message_control_id` text,
	`related_patient_name` text,
	`metadata` text,
	`prior_work_status` text,
	`resolved_at` integer,
	`resolved_by_actor` text,
	`resolution` text,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `referral_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_exceptions_workspace` ON `workspace_exceptions` (`workspace_id`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `idx_workspace_exceptions_open` ON `workspace_exceptions` (`resolved_at`,`exception_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_exceptions_dedupe` ON `workspace_exceptions` (`exception_type`,`message_control_id`) WHERE "workspace_exceptions"."resolved_at" IS NULL AND "workspace_exceptions"."message_control_id" IS NOT NULL;