ALTER TABLE `store_connections` ADD `backfill_status` text;--> statement-breakpoint
ALTER TABLE `store_connections` ADD `backfill_since` integer;--> statement-breakpoint
ALTER TABLE `store_connections` ADD `backfill_cursor` text;--> statement-breakpoint
ALTER TABLE `store_connections` ADD `backfill_imported` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `store_connections` ADD `backfill_started_at` integer;--> statement-breakpoint
ALTER TABLE `store_connections` ADD `backfill_finished_at` integer;--> statement-breakpoint
ALTER TABLE `store_connections` ADD `backfill_error` text;