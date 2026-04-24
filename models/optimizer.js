// models/optimizer.js
//
// CRUD for optimizer_suggestions, optimizer_ignore, optimizer_merge_log.
// Drives the Entity Optimizer sidebar UI.

const { db } = require('./db');

module.exports = {
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

  async optimizerMarkMergeRolledBack(id) {
    try {
      db.prepare('UPDATE optimizer_merge_log SET rolled_back_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      return true;
    } catch (error) {
      console.error('[ERROR] marking merge rolled back:', error);
      return false;
    }
  },

};
