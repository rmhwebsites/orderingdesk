CREATE TABLE `ai_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`tool` text NOT NULL,
	`target_id` text,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`outcome` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_actions_grant` ON `ai_actions` (`grant_id`);--> statement-breakpoint
CREATE INDEX `ai_actions_expires` ON `ai_actions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ai_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`user_id` text NOT NULL,
	`host` text NOT NULL,
	`client_id` text NOT NULL,
	`client` text NOT NULL,
	`client_domain` text,
	`redirect_host` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_reason` text,
	`kv_revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_grants_ws_user` ON `ai_grants` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `ai_grants_user` ON `ai_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `ai_sign_in_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`client_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`ip_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`verified_at` integer,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `ai_codes_email` ON `ai_sign_in_codes` (`origin`,`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_codes_ip` ON `ai_sign_in_codes` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_codes_expires` ON `ai_sign_in_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`actor_id` text NOT NULL,
	`grant_id` text,
	`client` text,
	`tool` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_ws_created` ON `audit_log` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_grant` ON `audit_log` (`grant_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `ai_team` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `ai_reads_per_day` integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `ai_staff_changes_per_day` integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `ai_manager_changes_per_day` integer DEFAULT 100 NOT NULL;