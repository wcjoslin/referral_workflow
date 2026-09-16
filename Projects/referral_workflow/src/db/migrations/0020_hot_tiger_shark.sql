ALTER TABLE `referral_workspaces` ADD `next_action_set_by` text;--> statement-breakpoint
ALTER TABLE `referral_workspaces` ADD `due_date_overridden` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `referral_workspaces` ADD `due_date_override_reason` text;--> statement-breakpoint
ALTER TABLE `referral_workspaces` ADD `overdue_notified_at` integer;--> statement-breakpoint
ALTER TABLE `referral_workspaces` ADD `awaited_by` text;--> statement-breakpoint
ALTER TABLE `referral_workspaces` ADD `awaited_by_party_id` integer;