CREATE TABLE recent_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    working_dir TEXT,
    generated_title TEXT,
    custom_title TEXT,
    todo_title TEXT,
    updated_at_ms INTEGER NOT NULL,
    last_active_at_ms INTEGER,
    saved INTEGER,
    save_label TEXT
);
INSERT INTO recent_sessions VALUES ('00000000-0000-4000-8000-000000000001', :cwd, 'Fixture jcode prompt 1', NULL, NULL, 1790000001000, 1790000001000, 0, NULL);
INSERT INTO recent_sessions VALUES ('00000000-0000-4000-8000-000000000002', :cwd, 'Fixture jcode prompt 2', NULL, NULL, 1790000003000, 1790000003000, 0, NULL);
