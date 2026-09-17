-- RFC-001 §4.2: schema for the seasonal leaderboard.

CREATE TABLE seasons (
  id         integer PRIMARY KEY,          -- e.g. 202609
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  tie_base   bigint NOT NULL,              -- value of tie_seq when the season was created
  CHECK (starts_at < ends_at),
  -- Seasons must not overlap: otherwise the active-season CTE in POST /score
  -- would return two rows and the UPSERT would run twice.
  EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&)
);

-- CACHE 1: with CACHE > 1 every session pre-allocates its own range and the
-- order across sessions no longer follows time.
CREATE SEQUENCE tie_seq AS bigint CACHE 1;

CREATE TABLE player_scores (
  season_id  integer NOT NULL,
  player_id  text    NOT NULL,
  score      bigint  NOT NULL,
  tie_seq    bigint  NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, player_id),
  -- Encoding limit (§2.2): score occupies the bits above 2^32 of a double.
  CHECK (abs(score) < 2097152)
) PARTITION BY LIST (season_id);

CREATE TABLE leaderboard_outbox (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id  integer NOT NULL,
  player_id  text    NOT NULL,
  score      bigint  NOT NULL,             -- absolute state, not the delta
  tie_seq    bigint  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Rows are deleted right after processing: keep dead tuples in check.
ALTER TABLE leaderboard_outbox SET (
  autovacuum_vacuum_scale_factor = 0,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_vacuum_cost_delay = 0,
  autovacuum_analyze_scale_factor = 0,
  autovacuum_analyze_threshold = 50000
);

-- Number of a batch-processing *attempt* (§4.4, watermark). Sequences never
-- roll back, so attempt numbers strictly increase.
CREATE SEQUENCE outbox_batch_seq AS bigint;

CREATE TABLE worker_state (
  season_id  integer PRIMARY KEY,
  last_batch bigint NOT NULL DEFAULT 0     -- last batch COMMITTED for the season
);

-- Helper used by migrations, the CLI and tests: create a season with its partition.
CREATE FUNCTION create_season(p_id integer, p_starts timestamptz, p_ends timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO seasons (id, starts_at, ends_at, tie_base)
  VALUES (p_id, p_starts, p_ends, nextval('tie_seq'));
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS player_scores_%s PARTITION OF player_scores FOR VALUES IN (%s) WITH (fillfactor = 85)',
    p_id, p_id);
  INSERT INTO worker_state (season_id) VALUES (p_id) ON CONFLICT DO NOTHING;
END $$;
