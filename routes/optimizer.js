// routes/optimizer.js
//
// Entity Optimizer routes.
// - Page route (/optimizer) uses isAuthenticated (redirects to /login)
// - API routes (/api/optimizer/*) use authenticateJWT (returns 401 on missing/invalid auth)
//   because they can be destructive: they can reassign thousands of documents and
//   delete correspondents.

const express = require('express');
const router = express.Router();

const { authenticateJWT, isAuthenticated } = require('./auth');
const entityOptimizer = require('../services/entityOptimizerService');
const optimizerAi = require('../services/optimizerAiService');
const db = require('../models/document');
const configFile = require('../config/config');

// -------- Page --------

router.get('/optimizer', isAuthenticated, (req, res) => {
  res.render('optimizer', {
    title: 'Optimizer',
    version: configFile.PAPERLESS_AI_VERSION || ' ',
  });
});

// -------- API: analyze / suggestions --------

router.post('/api/optimizer/analyze', authenticateJWT, async (req, res) => {
  try {
    const {
      entityType = 'correspondent',
      threshold = 0.85,
      useLlm = true,
      minDocuments = 0,
    } = req.body || {};
    const result = await entityOptimizer.analyze(entityType, {
      threshold: parseFloat(threshold) || 0.85,
      useLlm: !!useLlm,
      minDocuments: parseInt(minDocuments, 10) || 0,
    });
    res.json(result);
  } catch (err) {
    console.error('[optimizer.analyze] error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/optimizer/suggestions', authenticateJWT, async (req, res) => {
  try {
    const entityType = req.query.entityType || 'correspondent';
    const status = req.query.status || null;
    const suggestions = await db.optimizerGetSuggestions(entityType, status);
    res.json({ entityType, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------- API: merge --------

router.post('/api/optimizer/merge', authenticateJWT, async (req, res) => {
  try {
    const {
      entityType = 'correspondent',
      canonicalId,
      canonicalName,
      mergeIds,
      dryRun = true,
      suggestionId = null,
    } = req.body || {};

    if (!canonicalId || !Array.isArray(mergeIds) || mergeIds.length === 0 || !canonicalName) {
      return res.status(400).json({ error: 'canonicalId, canonicalName, mergeIds required' });
    }

    const result = await entityOptimizer.executeMerge(entityType, {
      canonicalId: parseInt(canonicalId, 10),
      canonicalName: String(canonicalName).trim(),
      mergeIds: mergeIds.map(id => parseInt(id, 10)).filter(Number.isFinite),
      dryRun: !!dryRun,
    });

    if (!dryRun && suggestionId) {
      await db.optimizerSetSuggestionStatus(parseInt(suggestionId, 10), 'merged');
    }

    res.json(result);
  } catch (err) {
    console.error('[optimizer.merge] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------- API: ignore --------

router.post('/api/optimizer/ignore', authenticateJWT, async (req, res) => {
  try {
    const {
      entityType = 'correspondent',
      memberIds = [],
      memberNames = [],
      suggestionId = null,
    } = req.body || {};
    if (!Array.isArray(memberIds) || memberIds.length < 2) {
      return res.status(400).json({ error: 'memberIds must contain at least 2 ids' });
    }
    await entityOptimizer.ignoreCluster(
      entityType,
      memberIds.map(id => parseInt(id, 10)),
      memberNames
    );
    if (suggestionId) {
      await db.optimizerSetSuggestionStatus(parseInt(suggestionId, 10), 'ignored');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/optimizer/ignore', authenticateJWT, async (req, res) => {
  try {
    const entityType = req.query.entityType || 'correspondent';
    const ignores = await db.optimizerGetIgnoreList(entityType);
    res.json({ entityType, ignores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/optimizer/ignore/:id', authenticateJWT, async (req, res) => {
  try {
    await db.optimizerRemoveIgnore(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------- API: history / rollback --------

router.get('/api/optimizer/history', authenticateJWT, async (req, res) => {
  try {
    const entityType = req.query.entityType || null;
    const log = await db.optimizerGetMergeLog(entityType);
    res.json({ history: log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/rollback/:id', authenticateJWT, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const entry = await db.optimizerGetMergeLogEntry(id);
    if (!entry) return res.status(404).json({ error: 'Log entry not found' });
    const result = await entityOptimizer.rollback(entry.entity_type, id);
    res.json(result);
  } catch (err) {
    console.error('[optimizer.rollback] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------- API: provider info --------

router.get('/api/optimizer/provider', authenticateJWT, (req, res) => {
  res.json(optimizerAi.describeProvider());
});

// -------- API: sync-status (for sidebar badge) --------

router.get('/api/optimizer/sync-status', authenticateJWT, async (req, res) => {
  try {
    const counts = await db.optimizerPendingCounts();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------- API: Wartung --------

router.get('/api/optimizer/maintenance/status', authenticateJWT, async (req, res) => {
  try {
    const paperless = require('../services/paperlessService');
    const [paperlessDocCount, paperlessCorrCount, paperlessTagCount, tracked, processed] = await Promise.all([
      paperless.getDocumentCount(),
      paperless.getCorrespondentCount(),
      paperless.getTagCount(),
      db.getTrackedDocumentIds(),
      db.getProcessedDocumentsCount(),
    ]);
    res.json({
      paperless: {
        documents: paperlessDocCount,
        correspondents: paperlessCorrCount,
        tags: paperlessTagCount,
      },
      tracking: {
        processed: processed,
        tracked_ids: tracked.length,
        diff: paperlessDocCount - processed,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/maintenance/prune-orphans', authenticateJWT, async (req, res) => {
  try {
    const paperless = require('../services/paperlessService');
    const validIds = await paperless.getAllDocumentIds();
    const result = await db.pruneOrphans(validIds);
    res.json({ scanned: validIds.length, ...result });
  } catch (err) {
    console.error('[optimizer.maintenance.prune]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/maintenance/reset-tracking', authenticateJWT, async (req, res) => {
  try {
    const result = await db.resetProcessingTracking();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/optimizer/maintenance/tag-stats', authenticateJWT, async (req, res) => {
  try {
    const stats = await entityOptimizer.tagStatistics();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/maintenance/delete-orphan-tags', authenticateJWT, async (req, res) => {
  try {
    const result = await entityOptimizer.deleteOrphanTags();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/maintenance/wipe-all-tags', authenticateJWT, async (req, res) => {
  try {
    const { deleteDefinitions = false, preserveNames = [] } = req.body || {};
    // Defaultmäßig ai-processed-Tag schützen, falls konfiguriert
    const preserve = new Set([
      ...preserveNames,
      configFile.addAIProcessedTags || 'ai-processed',
    ]);
    const result = await entityOptimizer.wipeAllTags({
      deleteDefinitions: !!deleteDefinitions,
      preserveNames: [...preserve],
    });
    // Backup nicht ins HTTP-Log, nur Summary
    const summary = { ...result };
    delete summary.backup;
    res.json({
      ...summary,
      backupAvailable: result.backupSize > 0,
      hint: 'Das vollständige Backup wurde im Container-Log protokolliert.',
    });
    // Backup in den Server-Log dumpen (kompakt)
    if (result.backup?.length) {
      console.log('[optimizer.wipe-all-tags] Backup JSON (für Re-Import):');
      console.log(JSON.stringify({
        created_at: new Date().toISOString(),
        documents_affected: result.documentsAffected,
        tags_processed: result.tagsProcessed,
        backup: result.backup,
      }));
    }
  } catch (err) {
    console.error('[optimizer.wipe-all-tags]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/optimizer/maintenance/document-type-stats', authenticateJWT, async (req, res) => {
  try {
    const stats = await entityOptimizer.documentTypeStatistics();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/maintenance/delete-orphan-document-types', authenticateJWT, async (req, res) => {
  try {
    const result = await entityOptimizer.deleteOrphanDocumentTypes();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/maintenance/wipe-all-document-types', authenticateJWT, async (req, res) => {
  try {
    const { deleteDefinitions = false, preserveNames = [] } = req.body || {};
    const result = await entityOptimizer.wipeAllDocumentTypes({
      deleteDefinitions: !!deleteDefinitions,
      preserveNames,
    });
    const summary = { ...result };
    delete summary.backup;
    res.json({
      ...summary,
      backupAvailable: result.backupSize > 0,
      hint: 'Das vollständige Backup wurde im Container-Log protokolliert.',
    });
    if (result.backup?.length) {
      console.log('[optimizer.wipe-all-document-types] Backup JSON (für Re-Import):');
      console.log(JSON.stringify({
        created_at: new Date().toISOString(),
        documents_affected: result.documentsAffected,
        types_processed: result.typesProcessed,
        backup: result.backup,
      }));
    }
  } catch (err) {
    console.error('[optimizer.wipe-all-document-types]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/optimizer/maintenance/create-tax-views', authenticateJWT, async (req, res) => {
  try {
    const { year, showOnDashboard = false } = req.body || {};
    if (!year) return res.status(400).json({ error: 'year fehlt' });
    const result = await entityOptimizer.createTaxSavedViews(year, { showOnDashboard: !!showOnDashboard });
    res.json(result);
  } catch (err) {
    console.error('[optimizer.create-tax-views]', err);
    res.status(500).json({ error: err.message });
  }
});

// Trigger sync check manually
router.post('/api/optimizer/sync-run', authenticateJWT, async (req, res) => {
  try {
    const optimizerService = require('../services/entityOptimizerService');
    // Run in the background, return immediately so the UI doesn't block.
    (async () => {
      try {
        await optimizerService.analyze('correspondent', { threshold: 0.85, useLlm: true, minDocuments: 0 });
        await optimizerService.analyze('tag', { threshold: 0.85, useLlm: true, minDocuments: 0 });
      } catch (e) {
        console.error('[optimizer.sync-run] failed:', e.message);
      }
    })();
    res.json({ ok: true, started: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
