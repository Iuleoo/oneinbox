CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`provider` text NOT NULL,
	`color` text NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer DEFAULT 993 NOT NULL,
	`imap_tls` integer DEFAULT 1 NOT NULL,
	`allow_insecure_tls` integer DEFAULT 0 NOT NULL,
	`auth_type` text NOT NULL,
	`secret_enc` blob NOT NULL,
	`secret_iv` blob NOT NULL,
	`secret_tag` blob NOT NULL,
	`oauth_client_id` text,
	`oauth_client_secret_enc` blob,
	`oauth_client_secret_iv` blob,
	`oauth_client_secret_tag` blob,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sync_days` integer DEFAULT 30 NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_email_unique` ON `accounts` (`email`);--> statement-breakpoint
CREATE TABLE `app_user` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_username_unique` ON `app_user` (`username`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	`part_id` text NOT NULL,
	`filename` text,
	`content_type` text,
	`size` integer,
	`content_id` text,
	`is_inline` integer DEFAULT 0 NOT NULL,
	`cache_path` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attachments_message_part` ON `attachments` (`message_id`,`part_id`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`path` text NOT NULL,
	`display_name` text NOT NULL,
	`special_use` text,
	`delimiter` text,
	`subscribed` integer DEFAULT 0 NOT NULL,
	`uidvalidity` integer,
	`uidnext` integer,
	`highest_modseq` integer,
	`total_count` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`last_sync_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_folders_account_path` ON `folders` (`account_id`,`path`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`folder_id` integer NOT NULL,
	`uid` integer NOT NULL,
	`message_id` text,
	`thread_id` text,
	`from_name` text,
	`from_addr` text,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`reply_to_addr` text,
	`subject` text,
	`snippet` text,
	`date` integer NOT NULL,
	`internal_date` integer NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`flagged` integer DEFAULT 0 NOT NULL,
	`answered` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`has_attachments` integer DEFAULT 0 NOT NULL,
	`size` integer,
	`body_parts` text,
	`body_state` text DEFAULT 'none' NOT NULL,
	`body_html` text,
	`body_text` text,
	`body_fetched_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_folder_uid` ON `messages` (`folder_id`,`uid`);--> statement-breakpoint
CREATE INDEX `idx_messages_unified` ON `messages` ("internal_date" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `idx_messages_folder` ON `messages` (`folder_id`,"internal_date" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `idx_messages_account` ON `messages` (`account_id`,"internal_date" DESC);--> statement-breakpoint
CREATE INDEX `idx_messages_unseen` ON `messages` (`folder_id`,`seen`);--> statement-breakpoint
CREATE INDEX `idx_messages_msgid` ON `messages` (`message_id`);--> statement-breakpoint
CREATE TABLE `pending_ops` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`op` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pending_ops_account` ON `pending_ops` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
