ALTER TABLE `purchase_orders` ADD `currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `send_started_at` integer;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `send_attempt` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `sent_to` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `sent_by` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `send_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `updated_at` integer;