CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`shopify_location_id` text NOT NULL,
	`company_id` text,
	`name` text NOT NULL,
	`address` text,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_shopify_unique` ON `locations` (`workspace_id`,`shopify_location_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `location_id` text;