CREATE TABLE IF NOT EXISTS result_cache_entries (
  cache_key VARCHAR(512) PRIMARY KEY,
  operation_type VARCHAR(20) NOT NULL,
  server_id VARCHAR(128) NOT NULL,
  entity_id VARCHAR(256) NOT NULL,
  scope_type VARCHAR(20) NOT NULL,
  scope_hash VARCHAR(64) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  payload_encoding VARCHAR(20) NOT NULL DEFAULT 'json',
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  payload_blob BYTEA NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rce_expires_at ON result_cache_entries (expires_at);
CREATE INDEX IF NOT EXISTS idx_rce_server_op_entity ON result_cache_entries (server_id, operation_type, entity_id);

CREATE TABLE IF NOT EXISTS result_cache_namespace_versions (
  namespace_key VARCHAR(512) PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS result_cache_admission_counters (
  admission_key VARCHAR(512) PRIMARY KEY,
  observation_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rcac_expires_at ON result_cache_admission_counters (expires_at);
