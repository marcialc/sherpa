-- Private discovery metadata only; never executor evidence or source code.
CREATE TABLE index_repositories (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  active_revision TEXT,
  build_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, repository_id)
);
CREATE TABLE index_revisions (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('building','ready','failed','superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, repository_id, id)
);
CREATE INDEX index_revision_lookup ON index_revisions(installation_id, repository_id, commit_sha, version, status);
CREATE TABLE index_files (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  version TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_id, id)
);
CREATE TABLE index_members (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  path TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_id, revision_id, path),
  FOREIGN KEY (installation_id, repository_id, revision_id) REFERENCES index_revisions(installation_id, repository_id, id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id, repository_id, file_id) REFERENCES index_files(installation_id, repository_id, id)
);
CREATE INDEX index_member_file ON index_members(installation_id, repository_id, file_id);
CREATE TABLE index_terms (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  file_id TEXT NOT NULL,
  weight INTEGER NOT NULL,
  PRIMARY KEY (installation_id, repository_id, term, file_id),
  FOREIGN KEY (installation_id, repository_id, file_id) REFERENCES index_files(installation_id, repository_id, id) ON DELETE CASCADE
);
