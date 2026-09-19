-- Full-text search over messages (external-content FTS5 table kept in sync by triggers).
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
	`subject`, `from_name`, `from_addr`, `snippet`, `body_text`,
	content='messages', content_rowid='id',
	tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER `messages_ai` AFTER INSERT ON `messages` BEGIN
	INSERT INTO `messages_fts`(rowid, subject, from_name, from_addr, snippet, body_text)
	VALUES (new.id, new.subject, new.from_name, new.from_addr, new.snippet, new.body_text);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_ad` AFTER DELETE ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, rowid, subject, from_name, from_addr, snippet, body_text)
	VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.snippet, old.body_text);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE OF subject, from_name, from_addr, snippet, body_text ON `messages` BEGIN
	INSERT INTO `messages_fts`(`messages_fts`, rowid, subject, from_name, from_addr, snippet, body_text)
	VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, old.snippet, old.body_text);
	INSERT INTO `messages_fts`(rowid, subject, from_name, from_addr, snippet, body_text)
	VALUES (new.id, new.subject, new.from_name, new.from_addr, new.snippet, new.body_text);
END;
