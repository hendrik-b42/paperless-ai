// models/document.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { get } = require('http');

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

// Create tables
const createTableMain = db.prepare(`
  CREATE TABLE IF NOT EXISTS processed_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER UNIQUE,
    title TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createTableMain.run();

const createTableMetrics = db.prepare(`
  CREATE TABLE IF NOT EXISTS openai_metrics (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    promptTokens INTEGER,
    completionTokens INTEGER,
    totalTokens INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createTableMetrics.run();

const createTableHistory = db.prepare(`
  CREATE TABLE IF NOT EXISTS history_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    tags TEXT,
    title TEXT,
    correspondent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createTableHistory.run();

const createOriginalDocuments = db.prepare(`
  CREATE TABLE IF NOT EXISTS original_documents (
    id INTEGER PRIMARY KEY,
    document_id INTEGER,
    title TEXT,
    tags TEXT,
    correspondent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
createOriginalDocuments.run();

const userTable = db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
userTable.run();


// Prepare statements for better performance
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

// Add these prepared statements with your other ones at the top
const getHistoryDocumentsCount = db.prepare(`
  SELECT COUNT(*) as count FROM history_documents
`);

const getPaginatedHistoryDocuments = db.prepare(`
  SELECT * FROM history_documents 
  ORDER BY created_at DESC
  LIMIT ? OFFSET ?
`);

const createProcessingStatus = db.prepare(`
  CREATE TABLE IF NOT EXISTS processing_status (
    id INTEGER PRIMARY KEY,
    document_id INTEGER UNIQUE,
    title TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT
  );
`);
createProcessingStatus.run();

// ---------------------------------------------------------------------------
// Entity Optimizer (Phase 1: correspondents, extensible to tags/doctypes)
// ---------------------------------------------------------------------------
// entity_type: 'correspondent' | 'tag' | 'document_type'

const createOptimizerIgnore = db.prepare(`
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
`);
createOptimizerIgnore.run();

const createOptimizerSuggestions = db.prepare(`
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
`);
createOptimizerSuggestions.run();

const createOptimizerMergeLog = db.prepare(`
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
`);
createOptimizerMergeLog.run();

// Add with your other prepared statements
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


module.exports = {
  async addProcessedDocument(documentId, title) {
    try {
      // Bei UNIQUE constraint failure wird der existierende Eintrag aktualisiert
      const result = insertDocument.run(documentId, title, documentId);
      if (result.changes > 0) {
        console.log(`[DEBUG] Document ${title} ${result.lastInsertRowid ? 'added to' : 'updated in'} processed_documents`);
        return true;
      }
      return false;
    } catch (error) {
      // Log error but don't throw
      console.error('[ERROR] adding document:', error);
      return false;
    }
  },

  async addOpenAIMetrics(documentId, promptTokens, completionTokens, totalTokens) {
    try {
      const result = insertMetrics.run(documentId, promptTokens, completionTokens, totalTokens);
      if (result.changes > 0) {
        console.log(`[DEBUG] Metrics added for document ${documentId}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] adding metrics:', error);
      return false;
    }
  },

  async getMetrics() {
    try {
      return db.prepare('SELECT * FROM openai_metrics').all();
    } catch (error) {
      console.error('[ERROR] getting metrics:', error);
      return [];
    }
  },

  async getProcessedDocuments() {
    try {
      return db.prepare('SELECT * FROM processed_documents').all();
    } catch (error) {
      console.error('[ERROR] getting processed documents:', error);
      return [];
    }
  },

  async getProcessedDocumentsCount() {
    try {
      return db.prepare('SELECT COUNT(*) FROM processed_documents').pluck().get();
    } catch (error) {
      console.error('[ERROR] getting processed documents count:', error);
      return 0;
    }
  },

  async isDocumentProcessed(documentId) {
    try {
      const row = findDocument.get(documentId);
      return !!row;
    } catch (error) {
      console.error('[ERROR] checking document:', error);
      // Im Zweifelsfall true zurückgeben, um doppelte Verarbeitung zu vermeiden
      return true;
    }
  },

  async saveOriginalData(documentId, tags, correspondent, title) {
    try {
      const tagsString = JSON.stringify(tags); // Konvertiere Array zu String
      const result = db.prepare(`
        INSERT INTO original_documents (document_id, title, tags, correspondent)
        VALUES (?, ?, ?, ?)
      `).run(documentId, title, tagsString, correspondent);
      if (result.changes > 0) {
        console.log(`[DEBUG] Original data for document ${title} saved`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] saving original data:', error);
      return false;
    }
  },

  async addToHistory(documentId, tagIds, title, correspondent) {
    try {
      const tagIdsString = JSON.stringify(tagIds); // Konvertiere Array zu String
      const result = db.prepare(`
        INSERT INTO history_documents (document_id, tags, title, correspondent)
        VALUES (?, ?, ?, ?)
      `).run(documentId, tagIdsString, title, correspondent);
      if (result.changes > 0) {
        console.log(`[DEBUG] Document ${title} added to history`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] adding to history:', error);
      return false;
    }
  },

  async getHistory(id) {
    //check if id is provided else get all history
    if (id) {
      try {
        //only one document with id exists
        return db.prepare('SELECT * FROM history_documents WHERE document_id = ?').get(id);
      } catch (error) {
        console.error('[ERROR] getting history for id:', id, error);
        return [];
      }
    } else {
      try {
        return db.prepare('SELECT * FROM history_documents').all();
      } catch (error) {
        console.error('[ERROR] getting history for id:', id, error);
        return [];
      }
    }
  },

  async getOriginalData(id) {
    //check if id is provided else get all original data
    if (id) {
      try {
        //only one document with id exists
        return db.prepare('SELECT * FROM original_documents WHERE document_id = ?').get(id);
      } catch (error) {
        console.error('[ERROR] getting original data for id:', id, error);
        return [];
      }
    } else {
      try {
        return db.prepare('SELECT * FROM original_documents').all();
      } catch (error) {
        console.error('[ERROR] getting original data for id:', id, error);
        return [];
      }
    }
  },

  async getAllOriginalData() {
    try {
      return db.prepare('SELECT * FROM original_documents').all();
    } catch (error) {
      console.error('[ERROR] getting original data:', error);
      return [];
    }
  },

  async getAllHistory() {
    try {
      return db.prepare('SELECT * FROM history_documents').all();
    } catch (error) {
      console.error('[ERROR] getting history:', error);
      return [];
    }
  },

  async getHistoryDocumentsCount() {
    try {
      const result = getHistoryDocumentsCount.get();
      return result.count;
    } catch (error) {
      console.error('[ERROR] getting history documents count:', error);
      return 0;
    }
  },
  
  async getPaginatedHistory(limit, offset) {
    try {
      return getPaginatedHistoryDocuments.all(limit, offset);
    } catch (error) {
      console.error('[ERROR] getting paginated history:', error);
      return [];
    }
  },

  async deleteAllDocuments() {
    try {
      db.prepare('DELETE FROM processed_documents').run();
      console.log('[DEBUG] All processed_documents deleted');
      db.prepare('DELETE FROM history_documents').run();
      console.log('[DEBUG] All history_documents deleted');
      db.prepare('DELETE FROM original_documents').run();
      console.log('[DEBUG] All original_documents deleted');
      return true;
    } catch (error) {
      console.error('[ERROR] deleting documents:', error);
      return false;
    }
  },

  async deleteDocumentsIdList(idList) {
    try {
      console.log('[DEBUG] Received idList:', idList);
  
      const ids = Array.isArray(idList) ? idList : (idList?.ids || []);
  
      if (!Array.isArray(ids) || ids.length === 0) {
        console.error('[ERROR] Invalid input: must provide an array of ids');
        return false;
      }
  
      // Convert string IDs to integers
      const numericIds = ids.map(id => parseInt(id, 10));
  
      const placeholders = numericIds.map(() => '?').join(', ');
      const query = `DELETE FROM processed_documents WHERE document_id IN (${placeholders})`;
      const query2 = `DELETE FROM history_documents WHERE document_id IN (${placeholders})`;
      const query3 = `DELETE FROM original_documents WHERE document_id IN (${placeholders})`;
      console.log('[DEBUG] Executing SQL query:', query);
      console.log('[DEBUG] Executing SQL query:', query2);
      console.log('[DEBUG] Executing SQL query:', query3);
      console.log('[DEBUG] With parameters:', numericIds);
  
      const stmt = db.prepare(query);
      const stmt2 = db.prepare(query2);
      const stmt3 = db.prepare(query3);
      const result = stmt.run(numericIds);
      const result2 = stmt2.run(numericIds);
      const result3 = stmt3.run(numericIds);

      console.log('[DEBUG] SQL result:', result);
      console.log('[DEBUG] SQL result:', result2);
      console.log('[DEBUG] SQL result:', result3);
      console.log(`[DEBUG] Documents with IDs ${numericIds.join(', ')} deleted`);
      return true;
    } catch (error) {
      console.error('[ERROR] deleting documents:', error);
      return false;
    }
  },


  async addUser(username, password) {
    try {
      // Lösche alle vorhandenen Benutzer
      const deleteResult = db.prepare('DELETE FROM users').run();
      console.log(`[DEBUG] ${deleteResult.changes} existing users deleted`);
  
      // Füge den neuen Benutzer hinzu
      const result = insertUser.run(username, password);
      if (result.changes > 0) {
        console.log(`[DEBUG] User ${username} added`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('[ERROR] adding user:', error);
      return false;
    }
  },

  async getUser(username) {
    try {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    } catch (error) {
      console.error('[ERROR] getting user:', error);
      return [];
    }
  },

  async getUsers() {
    try {
      return db.prepare('SELECT * FROM users').all();
    } catch (error) {
      console.error('[ERROR] getting users:', error);
      return [];
    }
  },

  async getProcessingTimeStats() {
    try {
      return db.prepare(`
        SELECT 
          strftime('%H', processed_at) as hour,
          COUNT(*) as count
        FROM processed_documents 
        WHERE date(processed_at) = date('now')
        GROUP BY hour
        ORDER BY hour
      `).all();
    } catch (error) {
      console.error('[ERROR] getting processing time stats:', error);
      return [];
    }
  },
  
  async  getTokenDistribution() {
    try {
      return db.prepare(`
        SELECT 
          CASE 
            WHEN totalTokens < 1000 THEN '0-1k'
            WHEN totalTokens < 2000 THEN '1k-2k'
            WHEN totalTokens < 3000 THEN '2k-3k'
            WHEN totalTokens < 4000 THEN '3k-4k'
            WHEN totalTokens < 5000 THEN '4k-5k'
            ELSE '5k+'
          END as range,
          COUNT(*) as count
        FROM openai_metrics
        GROUP BY range
        ORDER BY range
      `).all();
    } catch (error) {
      console.error('[ERROR] getting token distribution:', error);
      return [];
    }
  },
  
  async getDocumentTypeStats() {
    try {
      return db.prepare(`
        SELECT 
          substr(title, 1, instr(title || ' ', ' ') - 1) as type,
          COUNT(*) as count
        FROM processed_documents
        GROUP BY type
      `).all();
    } catch (error) {
      console.error('[ERROR] getting document type stats:', error);
      return [];
    }
},

async setProcessingStatus(documentId, title, status) {
  try {
      if (status === 'complete') {
          const result = clearProcessingStatus.run(documentId);
          return result.changes > 0;
      } else {
          const result = upsertProcessingStatus.run(documentId, title, status);
          return result.changes > 0;
      }
  } catch (error) {
      console.error('[ERROR] updating processing status:', error);
      return false;
  }
},

async getCurrentProcessingStatus() {
  try {
      const active = getActiveProcessing.get();
      
      // Get last processed document with explicit UTC time
      const lastProcessed = db.prepare(`
          SELECT 
              document_id, 
              title, 
              datetime(processed_at) as processed_at 
          FROM processed_documents 
          ORDER BY processed_at DESC 
          LIMIT 1`
      ).get();

      const processedToday = db.prepare(`
          SELECT COUNT(*) as count 
          FROM processed_documents 
          WHERE date(processed_at) = date('now', 'localtime')`
      ).get();

      return {
          currentlyProcessing: active ? {
              documentId: active.document_id,
              title: active.title,
              startTime: active.start_time,
              status: active.status
          } : null,
          lastProcessed: lastProcessed ? {
              documentId: lastProcessed.document_id,
              title: lastProcessed.title,
              processed_at: lastProcessed.processed_at
          } : null,
          processedToday: processedToday.count,
          isProcessing: !!active
      };
  } catch (error) {
      console.error('[ERROR] getting current processing status:', error);
      return {
          currentlyProcessing: null,
          lastProcessed: null,
          processedToday: 0,
          isProcessing: false
      };
  }
},


  // -----------------------------------------------------------------------
  // Entity Optimizer
  // -----------------------------------------------------------------------

  /**
   * Speichert (oder aktualisiert) eine Cluster-Empfehlung.
   * members ist ein Array von { id, name, document_count }.
   */
  async optimizerUpsertSuggestion(entityType, clusterKey, canonicalName, canonicalId, members, confidence, reason, status = 'pending') {
    try {
      const stmt = db.prepare(`
        INSERT INTO optimizer_suggestions
          (entity_type, cluster_key, canonical_name, canonical_id, members_json, confidence, reason, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(entity_type, cluster_key) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          canonical_id = excluded.canonical_id,
          members_json = excluded.members_json,
          confidence = excluded.confidence,
          reason = excluded.reason,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `);
      stmt.run(entityType, clusterKey, canonicalName, canonicalId, JSON.stringify(members), confidence, reason, status);
      return true;
    } catch (error) {
      console.error('[ERROR] upserting optimizer suggestion:', error);
      return false;
    }
  },

  async optimizerGetSuggestions(entityType, status = null) {
    try {
      const rows = status
        ? db.prepare('SELECT * FROM optimizer_suggestions WHERE entity_type = ? AND status = ? ORDER BY confidence DESC, id DESC').all(entityType, status)
        : db.prepare('SELECT * FROM optimizer_suggestions WHERE entity_type = ? ORDER BY confidence DESC, id DESC').all(entityType);
      return rows.map(r => ({ ...r, members: JSON.parse(r.members_json || '[]') }));
    } catch (error) {
      console.error('[ERROR] getting optimizer suggestions:', error);
      return [];
    }
  },

  /**
   * Zählt pending Suggestions pro Entity-Typ — für das Sidebar-Badge.
   * Liefert { correspondent: N, tag: M, total: N+M }.
   */
  async optimizerPendingCounts() {
    try {
      const rows = db.prepare(`
        SELECT entity_type, COUNT(*) as c
        FROM optimizer_suggestions
        WHERE status = 'pending'
        GROUP BY entity_type
      `).all();
      const out = { correspondent: 0, tag: 0, document_type: 0, total: 0 };
      for (const r of rows) {
        out[r.entity_type] = r.c;
        out.total += r.c;
      }
      return out;
    } catch (error) {
      console.error('[ERROR] optimizerPendingCounts:', error);
      return { correspondent: 0, tag: 0, document_type: 0, total: 0 };
    }
  },

  async optimizerClearPendingSuggestions(entityType) {
    try {
      db.prepare("DELETE FROM optimizer_suggestions WHERE entity_type = ? AND status = 'pending'").run(entityType);
      return true;
    } catch (error) {
      console.error('[ERROR] clearing pending suggestions:', error);
      return false;
    }
  },

  async optimizerSetSuggestionStatus(suggestionId, status) {
    try {
      db.prepare('UPDATE optimizer_suggestions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, suggestionId);
      return true;
    } catch (error) {
      console.error('[ERROR] setting suggestion status:', error);
      return false;
    }
  },

  /**
   * Zwei Entitäten dauerhaft zum Ignorieren markieren.
   * Speichert als ungeordnetes Paar (kleinere ID zuerst) damit (a,b) und (b,a) identisch sind.
   */
  async optimizerAddIgnore(entityType, idA, nameA, idB, nameB) {
    try {
      const lo = Math.min(idA, idB);
      const hi = Math.max(idA, idB);
      const nameLo = lo === idA ? nameA : nameB;
      const nameHi = lo === idA ? nameB : nameA;
      db.prepare(`
        INSERT OR IGNORE INTO optimizer_ignore (entity_type, entity_id_a, entity_id_b, name_a, name_b)
        VALUES (?, ?, ?, ?, ?)
      `).run(entityType, lo, hi, nameLo, nameHi);
      return true;
    } catch (error) {
      console.error('[ERROR] adding optimizer ignore:', error);
      return false;
    }
  },

  async optimizerGetIgnoreSet(entityType) {
    try {
      const rows = db.prepare('SELECT entity_id_a, entity_id_b FROM optimizer_ignore WHERE entity_type = ?').all(entityType);
      // Return a Set of "lo:hi" strings for fast lookup
      return new Set(rows.map(r => `${r.entity_id_a}:${r.entity_id_b}`));
    } catch (error) {
      console.error('[ERROR] getting ignore set:', error);
      return new Set();
    }
  },

  async optimizerGetIgnoreList(entityType) {
    try {
      return db.prepare('SELECT * FROM optimizer_ignore WHERE entity_type = ? ORDER BY created_at DESC').all(entityType);
    } catch (error) {
      console.error('[ERROR] getting ignore list:', error);
      return [];
    }
  },

  async optimizerRemoveIgnore(ignoreId) {
    try {
      db.prepare('DELETE FROM optimizer_ignore WHERE id = ?').run(ignoreId);
      return true;
    } catch (error) {
      console.error('[ERROR] removing optimizer ignore:', error);
      return false;
    }
  },

  /**
   * Merge-Log-Eintrag für Rollback schreiben.
   * mergedEntities = [{ id, name }] der zusammengeführten (gelöschten) Einheiten.
   * affectedDocuments = [{ documentId, previousEntityId }] für präzises Zurückrollen.
   */
  async optimizerLogMerge(entityType, canonicalName, canonicalId, mergedEntities, affectedDocuments, dryRun) {
    try {
      const result = db.prepare(`
        INSERT INTO optimizer_merge_log
          (entity_type, canonical_name, canonical_id, merged_entities_json, affected_documents_json, dry_run)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entityType,
        canonicalName,
        canonicalId,
        JSON.stringify(mergedEntities),
        JSON.stringify(affectedDocuments),
        dryRun ? 1 : 0
      );
      return result.lastInsertRowid;
    } catch (error) {
      console.error('[ERROR] logging merge:', error);
      return null;
    }
  },

  async optimizerGetMergeLog(entityType = null) {
    try {
      const rows = entityType
        ? db.prepare('SELECT * FROM optimizer_merge_log WHERE entity_type = ? ORDER BY created_at DESC').all(entityType)
        : db.prepare('SELECT * FROM optimizer_merge_log ORDER BY created_at DESC').all();
      return rows.map(r => ({
        ...r,
        merged_entities: JSON.parse(r.merged_entities_json || '[]'),
        affected_documents: JSON.parse(r.affected_documents_json || '[]'),
      }));
    } catch (error) {
      console.error('[ERROR] getting merge log:', error);
      return [];
    }
  },

  async optimizerGetMergeLogEntry(id) {
    try {
      const row = db.prepare('SELECT * FROM optimizer_merge_log WHERE id = ?').get(id);
      if (!row) return null;
      return {
        ...row,
        merged_entities: JSON.parse(row.merged_entities_json || '[]'),
        affected_documents: JSON.parse(row.affected_documents_json || '[]'),
      };
    } catch (error) {
      console.error('[ERROR] getting merge log entry:', error);
      return null;
    }
  },

  // -----------------------------------------------------------------------
  // Wartung / Reset
  // -----------------------------------------------------------------------

  /**
   * Liefert alle document_ids die in processed_documents getracked sind.
   * Wird für Orphan-Detection gebraucht.
   */
  async getTrackedDocumentIds() {
    try {
      return db.prepare('SELECT document_id FROM processed_documents').all().map(r => r.document_id);
    } catch (error) {
      console.error('[ERROR] getTrackedDocumentIds:', error);
      return [];
    }
  },

  /**
   * Entfernt Tracking-Einträge für Dokumente, die in Paperless-NGX nicht
   * mehr existieren. validDocumentIds ist die Liste der aktuell in
   * Paperless-NGX vorhandenen IDs.
   */
  async pruneOrphans(validDocumentIds) {
    try {
      const valid = new Set(validDocumentIds.map(Number));
      const tracked = db.prepare('SELECT document_id FROM processed_documents').all().map(r => r.document_id);
      const orphans = tracked.filter(id => !valid.has(id));
      if (orphans.length === 0) return { deleted: 0, orphans: [] };

      const placeholders = orphans.map(() => '?').join(',');
      db.prepare(`DELETE FROM processed_documents WHERE document_id IN (${placeholders})`).run(...orphans);
      db.prepare(`DELETE FROM history_documents WHERE document_id IN (${placeholders})`).run(...orphans);
      db.prepare(`DELETE FROM original_documents WHERE document_id IN (${placeholders})`).run(...orphans);
      return { deleted: orphans.length, orphans };
    } catch (error) {
      console.error('[ERROR] pruneOrphans:', error);
      return { deleted: 0, orphans: [], error: error.message };
    }
  },

  /**
   * Komplettes Zurücksetzen des Tracking. Beim nächsten Scan werden alle
   * Dokumente als "unprozessiert" behandelt.
   */
  async resetProcessingTracking() {
    try {
      const countBefore = db.prepare('SELECT COUNT(*) as c FROM processed_documents').get().c;
      db.prepare('DELETE FROM processed_documents').run();
      db.prepare('DELETE FROM processing_status').run();
      // openai_metrics, history_documents, original_documents BEWUSST NICHT löschen,
      // damit History/Audit erhalten bleibt.
      return { ok: true, cleared: countBefore };
    } catch (error) {
      console.error('[ERROR] resetProcessingTracking:', error);
      return { ok: false, error: error.message };
    }
  },

  async optimizerMarkMergeRolledBack(id) {
    try {
      db.prepare('UPDATE optimizer_merge_log SET rolled_back_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      return true;
    } catch (error) {
      console.error('[ERROR] marking merge rolled back:', error);
      return false;
    }
  },

  // Utility method to close the database connection
  closeDatabase() {
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
};
