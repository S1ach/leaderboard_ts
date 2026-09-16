-- Development bootstrap: a season for the current calendar month (UTC).
-- In production seasons are created ahead of time by a scheduled job (§8).
DO $$
DECLARE
  m timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  sid integer := to_char(now() AT TIME ZONE 'UTC', 'YYYYMM')::integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seasons WHERE id = sid) THEN
    PERFORM create_season(sid, m, m + interval '1 month');
  END IF;
END $$;
