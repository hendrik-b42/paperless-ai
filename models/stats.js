// models/stats.js
//
// Aggregate queries across processed_documents / openai_metrics.

const { db } = require('./db');

module.exports = {
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

};
