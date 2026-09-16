#!/bin/sh
# Creates a separate database for the integration test-suite.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<-SQL
  CREATE DATABASE leaderboard_test;
SQL
