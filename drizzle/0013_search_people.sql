CREATE TABLE `ai_usage` (
	`workspace_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`workspace_id`, `principal_id`, `day`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `order_search` (
	`order_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`haystack` text NOT NULL,
	`kind` text NOT NULL,
	`status_key` text NOT NULL,
	`closed` integer NOT NULL,
	`location_id` text,
	`requester_id` text,
	`created_at` integer NOT NULL,
	`status_set_at` integer
);
--> statement-breakpoint
CREATE INDEX `search_ws_closed_created` ON `order_search` (`workspace_id`,`closed`,`created_at`);--> statement-breakpoint
CREATE INDEX `search_ws_status` ON `order_search` (`workspace_id`,`status_key`);--> statement-breakpoint
CREATE INDEX `search_ws_location` ON `order_search` (`workspace_id`,`location_id`);--> statement-breakpoint
CREATE INDEX `search_ws_requester` ON `order_search` (`workspace_id`,`requester_id`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`shopify_customer_id` text NOT NULL,
	`name` text,
	`email` text,
	`company_contact_id` text,
	`location_id` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_customer_unique` ON `people` (`workspace_id`,`shopify_customer_id`);--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `time_zone` text DEFAULT 'America/New_York' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `ai_search` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `search_indexed_at` integer;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `search_backfill_cursor` text;