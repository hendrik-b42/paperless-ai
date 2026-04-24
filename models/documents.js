// models/documents.js
//
// CRUD for processed_documents, original_documents and processing_status.
// Used via the models/document.js façade; no direct call-site usage.

const {
  db,
  insertDocument,
  findDocument,
  insertOriginal,
  upsertProcessingStatus,
  clearProcessingStatus,
  getActiveProcessing,
} = require('./db');

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

  async getTrackedDocumentIds() {
    try {
      return db.prepare('SELECT document_id FROM processed_documents').all().map(r => r.document_id);
    } catch (error) {
      console.error('[ERROR] getTrackedDocumentIds:', error);
      return [];
    }
  },

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

};
