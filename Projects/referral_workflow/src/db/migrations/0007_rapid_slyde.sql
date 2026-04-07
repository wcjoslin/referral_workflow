CREATE TABLE `prior_auth_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`referral_id` integer,
	`patient_id` integer NOT NULL,
	`state` text DEFAULT 'Draft' NOT NULL,
	`claim_json` text NOT NULL,
	`bundle_json` text,
	`insurer_name` text NOT NULL,
	`insurer_id` text NOT NULL,
	`service_code` text NOT NULL,
	`service_display` text,
	`provider_npi` text NOT NULL,
	`provider_name` text NOT NULL,
	`subscriber_id` text,
	`subscription_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	FOREIGN KEY (`referral_id`) REFERENCES `referrals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prior_auth_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`response_json` text NOT NULL,
	`outcome` text NOT NULL,
	`review_action` text,
	`auth_number` text,
	`denial_reason` text,
	`item_adjudications` text,
	`received_via` text NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `prior_auth_requests`(`id`) ON UPDATE no action ON DELETE no action
);
