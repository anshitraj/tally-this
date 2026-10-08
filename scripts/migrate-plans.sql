-- Subscription plan per workspace. 'free' has no paid features; anything else enables them
-- (privacy mode, see PRIVACY_MODE_PLANS). plan_until is optional: a lapsed plan stops counting.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_until timestamp;
