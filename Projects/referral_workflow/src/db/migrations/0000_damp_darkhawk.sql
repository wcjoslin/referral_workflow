CREATE TABLE `outbound_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`referral_id` integer NOT NULL,
	`message_control_id` text NOT NULL,
	`message_type` text NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`sent_at` integer NOT NULL,
	`acknowledged_at` integer,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_messages_message_control_id_unique` ON `outbound_messages` (`message_control_id`);--> statement-breakpoint
CREATE TABLE `patients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`date_of_birth` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`patient_id` integer NOT NULL,
	`source_message_id` text NOT NULL,
	`referrer_address` text NOT NULL,
	`reason_for_referral` text,
	`state` text DEFAULT 'Received' NOT NULL,
	`decline_reason` text,
	`clinician_id` text,
	`appointment_date` text,
	`appointment_location` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referrals_source_message_id_unique` ON `referrals` (`source_message_id`);