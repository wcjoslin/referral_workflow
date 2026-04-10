ALTER TABLE `referrals` ADD `routing_department` text DEFAULT 'Unassigned' NOT NULL;--> statement-breakpoint
ALTER TABLE `referrals` ADD `routing_equipment` text;