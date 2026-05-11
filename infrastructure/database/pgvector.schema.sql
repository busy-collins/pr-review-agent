-- ============================================================
-- PR Review Agent — RDS pgvector Schema
-- Database: pr_review_history
-- Purpose:  Long-term review history and similarity search
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Table 1: review_sessions
-- Long-term archive of all completed PR reviews
-- Populated from DynamoDB before TTL expiry
-- ============================================================
CREATE TABLE IF NOT EXISTS review_sessions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id           TEXT NOT NULL UNIQUE,
  pr_number            INTEGER NOT NULL,
  repo                 TEXT NOT NULL,
  sender               TEXT NOT NULL,
  base_branch          TEXT,
  head_branch          TEXT,
  final_verdict        TEXT NOT NULL CHECK (final_verdict IN ('APPROVED', 'CHANGES_REQUESTED', 'ESCALATED')),
  overall_confidence   FLOAT NOT NULL CHECK (overall_confidence BETWEEN 0.0 AND 1.0),
  blocking_count       INTEGER NOT NULL DEFAULT 0,
  non_blocking_count   INTEGER NOT NULL DEFAULT 0,
  security_iterations  INTEGER NOT NULL DEFAULT 1,
  style_iterations     INTEGER NOT NULL DEFAULT 1,
  github_comment_url   TEXT,
  status               TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED', 'ESCALATED')),
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  diff_line_count      INTEGER
);

-- Indexes for common queries
CREATE INDEX idx_review_sessions_repo         ON review_sessions (repo);
CREATE INDEX idx_review_sessions_pr_number    ON review_sessions (pr_number);
CREATE INDEX idx_review_sessions_sender       ON review_sessions (sender);
CREATE INDEX idx_review_sessions_verdict      ON review_sessions (final_verdict);
CREATE INDEX idx_review_sessions_created_at   ON review_sessions (created_at DESC);

-- ============================================================
-- Table 2: review_findings
-- Individual findings from all completed reviews
-- Used for pattern analysis and similarity search
-- ============================================================
CREATE TABLE IF NOT EXISTS review_findings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id    TEXT NOT NULL REFERENCES review_sessions(session_id) ON DELETE CASCADE,
  agent         TEXT NOT NULL CHECK (agent IN ('security', 'style')),
  severity      TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  category      TEXT NOT NULL,
  file          TEXT NOT NULL,
  line          INTEGER NOT NULL,
  description   TEXT NOT NULL,
  suggestion    TEXT NOT NULL,
  blocks_pr     BOOLEAN NOT NULL DEFAULT FALSE,
  repo          TEXT NOT NULL,
  pr_number     INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- pgvector embedding column
  -- 1536 dimensions = text-embedding-3-small
  -- Used for finding similar past findings
  description_embedding vector(1536)
);

-- Indexes for filtering
CREATE INDEX idx_findings_session_id  ON review_findings (session_id);
CREATE INDEX idx_findings_category    ON review_findings (category);
CREATE INDEX idx_findings_severity    ON review_findings (severity);
CREATE INDEX idx_findings_repo        ON review_findings (repo);
CREATE INDEX idx_findings_agent       ON review_findings (agent);

-- pgvector IVFFlat index for similarity search
-- lists = sqrt(total_rows) — recalculate when table exceeds 1M rows
CREATE INDEX idx_findings_embedding ON review_findings
  USING ivfflat (description_embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================
-- Table 3: pr_diff_embeddings
-- Stores embeddings of PR diffs for similarity detection
-- Enables "has this pattern been seen before?" queries
-- ============================================================
CREATE TABLE IF NOT EXISTS pr_diff_embeddings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      TEXT NOT NULL REFERENCES review_sessions(session_id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  diff_chunk      TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  diff_embedding  vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_diff_embeddings_repo       ON pr_diff_embeddings (repo);
CREATE INDEX idx_diff_embeddings_pr_number  ON pr_diff_embeddings (pr_number);

-- pgvector index for diff similarity search
CREATE INDEX idx_diff_embedding_vec ON pr_diff_embeddings
  USING ivfflat (diff_embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================
-- Table 4: agent_performance
-- Tracks Ralph loop performance metrics over time
-- Powers the observability dashboard
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_performance (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id           TEXT NOT NULL REFERENCES review_sessions(session_id) ON DELETE CASCADE,
  agent                TEXT NOT NULL CHECK (agent IN ('security', 'style', 'aggregator')),
  iterations_used      INTEGER NOT NULL,
  final_confidence     FLOAT NOT NULL,
  findings_count       INTEGER NOT NULL DEFAULT 0,
  false_positives      INTEGER NOT NULL DEFAULT 0,
  execution_time_ms    INTEGER,
  token_count          INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_perf_agent       ON agent_performance (agent);
CREATE INDEX idx_agent_perf_created_at  ON agent_performance (created_at DESC);

-- ============================================================
-- Useful Views
-- ============================================================

-- View: Daily review summary
CREATE OR REPLACE VIEW daily_review_summary AS
SELECT
  DATE(created_at) AS review_date,
  COUNT(*) AS total_reviews,
  COUNT(*) FILTER (WHERE final_verdict = 'APPROVED') AS approved,
  COUNT(*) FILTER (WHERE final_verdict = 'CHANGES_REQUESTED') AS changes_requested,
  COUNT(*) FILTER (WHERE final_verdict = 'ESCALATED') AS escalated,
  ROUND(AVG(overall_confidence)::numeric, 3) AS avg_confidence,
  ROUND(AVG(blocking_count)::numeric, 2) AS avg_blocking_issues
FROM review_sessions
GROUP BY DATE(created_at)
ORDER BY review_date DESC;

-- View: Top vulnerability categories
CREATE OR REPLACE VIEW top_finding_categories AS
SELECT
  agent,
  category,
  severity,
  COUNT(*) AS occurrence_count,
  ROUND(AVG(
    CASE severity
      WHEN 'CRITICAL' THEN 5
      WHEN 'HIGH' THEN 4
      WHEN 'MEDIUM' THEN 3
      WHEN 'LOW' THEN 2
      ELSE 1
    END
  )::numeric, 2) AS avg_severity_score
FROM review_findings
GROUP BY agent, category, severity
ORDER BY occurrence_count DESC;

-- ============================================================
-- Similarity Search Functions
-- ============================================================

-- Function: Find similar findings to a new finding
-- Used by Security SubAgent to reference past patterns
CREATE OR REPLACE FUNCTION find_similar_findings(
  query_embedding vector(1536),
  similarity_threshold FLOAT DEFAULT 0.85,
  result_limit INTEGER DEFAULT 5
)
RETURNS TABLE (
  session_id TEXT,
  category TEXT,
  severity TEXT,
  description TEXT,
  suggestion TEXT,
  similarity FLOAT
)
LANGUAGE SQL AS $$
  SELECT
    f.session_id,
    f.category,
    f.severity,
    f.description,
    f.suggestion,
    1 - (f.description_embedding <=> query_embedding) AS similarity
  FROM review_findings f
  WHERE 1 - (f.description_embedding <=> query_embedding) >= similarity_threshold
  ORDER BY f.description_embedding <=> query_embedding
  LIMIT result_limit;
$$;