CREATE TABLE `attachment_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`patient_id` integer,
	`control_number` text NOT NULL,
	`claim_number` text,
	`payer_name` text NOT NULL,
	`payer_identifier` text NOT NULL,
	`subscriber_name` text NOT NULL,
	`subscriber_id` text,
	`subscriber_dob` text,
	`requested_loinc_codes` text NOT NULL,
	`source_file` text NOT NULL,
	`state` text DEFAULT 'Received' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_requests_control_number_unique` ON `attachment_requests` (`control_number`);--> statement-breakpoint
CREATE TABLE `attachment_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`loinc_code` text NOT NULL,
	`ccda_document_type` text NOT NULL,
	`ccda_xml` text,
	`fhir_data` text,
	`signed_by_name` text,
	`signed_by_npi` text,
	`signed_at` integer,
	`sent_at` integer,
	`x12_control_number` text,
	FOREIGN KEY (`request_id`) REFERENCES `attachment_requests`(`id`) ON UPDATE no action ON DELETE no action
);