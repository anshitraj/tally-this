-- Links a TallyThis user to their Neon Auth account. Empty until the person first signs in with Neon Auth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS neon_user_id text UNIQUE;
