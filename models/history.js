// models/history.js
//
// CRUD for history_documents (audit log of AI-generated metadata changes).

const { db, insertHistory, getHistoryDocumentsCount, getPaginatedHistoryDocuments } = require('./db');

module.exports = {
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

};
