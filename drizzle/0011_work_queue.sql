ALTER TABLE `statuses` ADD `closed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `age_amber_days` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `age_red_days` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `price_display` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
-- Hand-written data step (comprehensive desk design section 1): Delivered
-- and Rejected cards leave the Open view in every existing workspace, by
-- Shopify link, or by key where a workspace unlinked the status.
UPDATE `statuses` SET `closed` = 1 WHERE `shopify_link` IN ('delivered', 'draft_rejected') OR `key` IN ('delivered', 'rejected');
