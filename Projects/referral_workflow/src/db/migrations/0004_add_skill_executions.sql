CREATE TABLE `skill_executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_name` text NOT NULL,
	`referral_id` integer NOT NULL,
	`trigger_point` text NOT NULL,
	`matched` integer NOT NULL,
	`confidence` text NOT NULL,
	`action_taken` text,
	`explanation` text NOT NULL,
	`was_overridden` integer DEFAULT false NOT NULL,
	`overridden_by` text,
	`override_reason` text,
	`executed_at` integer NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `referrals` ADD COLUMN `priority_flag` integer DEFAULT false;
