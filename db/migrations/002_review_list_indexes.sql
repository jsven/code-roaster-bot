-- Indexes used by paginated review lists and repository/date filters.
CREATE INDEX IF NOT EXISTS idx_review_jobs_created_id
  ON review_jobs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_review_jobs_repository_created_id
  ON review_jobs(repository, created_at DESC, id DESC);
