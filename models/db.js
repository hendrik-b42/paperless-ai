// models/db.js
//
// Shared SQLite instance and all prepared statements for the application.
// Domain modules (models/documents.js, models/history.js, ...) import from
// here. The old monolithic models/document.js is now a thin façade that
// re-exports methods from those domain modules.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database with WAL mode for better performance
const db = new Database(path.join(dataDir, 'documents.db'), {
  //verbose: console.log
});
db.pragma('journal_mode = WAL');

// ---------------------------------------------------------------------------
// Table creation
// ---------------------------------------------------------------------------

db.prepare(`
  CREATE TABLE IF NOT EXISTS processed_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER UNIQUE,
    title TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS openai_metrics (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    promptTokens INTEGER,
    completionTokens INTEGER,
    totalTokens INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS history_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    tags TEXT,
    title TEXT,
    correspondent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS original_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    title TEXT,
    tags TEXT,
    correspondent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS processing_status (
    id INTEGER PRIMARY KEY,
    document_id INTEGER UNIQUE,
    title TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT
  );
`).run();

// ---------------------------------------------------------------------------
// Entity Optimizer tables (entity_type: 'correspondent' | 'tag' | 'document_type')
// ---------------------------------------------------------------------------

db.prepare(`
  CREATE TABLE IF NOT EXISTS optimizer_ignore (
    id INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id_a INTEGER NOT NULL,
    entity_id_b INTEGER NOT NULL,
    name_a TEXT,
    name_b TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, entity_id_a, entity_id_b)
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS optimizer_suggestions (
    id INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    cluster_key TEXT NOT NULL,
    canonical_name TEXT,
    canonical_id INTEGER,
    members_json TEXT NOT NULL,
    confidence REAL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, cluster_key)
  );
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS optimizer_merge_log (
    id INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    canonical_id INTEGER,
    merged_entities_json TEXT NOT NULL,
    affected_documents_json TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    rolled_back_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`).run();

// ---------------------------------------------------------------------------
// Prepared statements shared across domain modules
// ---------------------------------------------------------------------------

const insertDocument = db.prepare(`
  INSERT INTO processed_documents (document_id, title)
  VALUES (?, ?)
  ON CONFLICT(document_id) DO UPDATE SET
    last_updated = CURRENT_TIMESTAMP
  WHERE document_id = ?
`);

const findDocument = db.prepare(
  'SELECT * FROM processed_documents WHERE document_id = ?'
);

const insertMetrics = db.prepare(`
  INSERT INTO openai_metrics (document_id, promptTokens, completionTokens, totalTokens)
  VALUES (?, ?, ?, ?)
`);

const insertOriginal = db.prepare(`
  INSERT INTO original_documents (document_id, title, tags, correspondent)
  VALUES (?, ?, ?, ?)
`);

const insertHistory = db.prepare(`
  INSERT INTO history_documents (document_id, tags, title, correspondent)
  VALUES (?, ?, ?, ?)
`);

const insertUser = db.prepare(`
  INSERT INTO users (username, password)
  VALUES (?, ?)
`);

const getHistoryDocumentsCount = db.prepare(`
  SELECT COUNT(*) as count FROM history_documents
`);

const getPaginatedHistoryDocuments = db.prepare(`
  SELECT * FROM history_documents
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const upsertProcessingStatus = db.prepare(`
  INSERT INTO processing_status (document_id, title, status)
  VALUES (?, ?, ?)
  ON CONFLICT(document_id) DO UPDATE SET
    status = excluded.status,
    start_time = CURRENT_TIMESTAMP
  WHERE document_id = excluded.document_id
`);

const clearProcessingStatus = db.prepare(`
  DELETE FROM processing_status WHERE document_id = ?
`);

const getActiveProcessing = db.prepare(`
  SELECT * FROM processing_status
  WHERE start_time >= datetime('now', '-30 seconds')
  ORDER BY start_time DESC LIMIT 1
`);

function closeDatabase() {
  return new Promise((resolve, reject) => {
    try {
      db.close();
      console.log('[DEBUG] Database closed successfully');
      resolve();
    } catch (error) {
      console.error('[ERROR] closing database:', error);
      reject(error);
    }
  });
}

module.exports = {
  db,
  insertDocument,
  findDocument,
  insertMetrics,
  insertOriginal,
  insertHistory,
  insertUser,
  getHistoryDocumentsCount,
  getPaginatedHistoryDocuments,
  upsertProcessingStatus,
  clearProcessingStatus,
  getActiveProcessing,
  closeDatabase,
};
