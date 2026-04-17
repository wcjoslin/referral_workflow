CREATE TABLE `referral_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`referral_id` integer NOT NULL,
	`direction` text NOT NULL,
	`message_type` text NOT NULL,
	`subject` text,
	`summary` text NOT NULL,
	`sender_address` text,
	`recipient_address` text,
	`content_body` text,
	`content_hl7` text,
	`content_xml` text,
	`message_control_id` text,
	`ack_status` text,
	`ack_at` integer,
	`related_state_transition` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_referral_messages_referral` ON `referral_messages` (`referral_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_referral_messages_control_id` ON `referral_messages` (`message_control_id`);