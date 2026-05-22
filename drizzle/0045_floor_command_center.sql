-- 0045: floor command center — add daily_unit_goal, target_bags_per_hour, user_dashboard_config

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS daily_unit_goal integer;

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS target_bags_per_hour integer;

CREATE TABLE IF NOT EXISTS user_dashboard_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  board_key   text NOT NULL DEFAULT 'floor-command',
  layout_json jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT udc_user_board_unique UNIQUE (user_id, board_key)
);
