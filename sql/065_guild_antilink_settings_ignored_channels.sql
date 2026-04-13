ALTER TABLE guild_antilink_settings ADD COLUMN IF NOT EXISTS ignored_channel_ids TEXT[] DEFAULT '{}'::TEXT[];
