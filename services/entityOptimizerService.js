// services/entityOptimizerService.js
//
// Entity Optimizer for Paperless-NGX.
// Phase 1: correspondents. Architecture is generic so tags / document_types
// can be added by implementing an adapter.
//
// Pipeline:
//   1. Normalization       -> cheap, deterministic, groups exact-match variants
//   2. Fuzzy clustering    -> union-find across names with similarity >= threshold
//   3. LLM verification    -> per cluster, confirms merge + chooses canonical name
//   4. Persistence         -> suggestions stored so the review UI is cheap to re-open
//   5. Execution (manual)  -> merge/dry-run/ignore triggered from the UI

const paperlessService = require('./paperlessService');
const optimizerAi = require('./optimizerAiService');
const db = require('../models/document');

// ---------------------------------------------------------------------------
// Adapter: defines how to talk to paperless for a given entity type.
// Adding "tag" later = add a new adapter here, nothing else to refactor.
// ---------------------------------------------------------------------------

const ADAPTERS = {
  correspondent: {
    kind: 'single-ref',  // doc has ONE correspondent field
    listAll: () => paperlessService.listCorrespondentsNames(),
    docIdsForEntity: (id) => paperlessService.getDocumentIdsByCorrespondent(id),
    bulkReassign: (docIds, targetId, _sourceId) => paperlessService.bulkSetCorrespondent(docIds, targetId),
    rename: (id, newName) => paperlessService.renameCorrespondent(id, newName),
    delete: (id) => paperlessService.deleteCorrespondent(id),
    recreate: (name) => paperlessService.getOrCreateCorrespondent(name, { restrictToExistingCorrespondents: false }),
  },
  tag: {
    kind: 'multi-ref',  // doc has tags ARRAY — merge = add target, remove source
    listAll: () => paperlessService.listTagsWithCount(),
    docIdsForEntity: (id) => paperlessService.getDocumentIdsByTag(id),
    bulkReassign: (docIds, targetId, sourceId) =>
      paperlessService.bulkModifyTags(docIds, [targetId], [sourceId]),
    rename: (id, newName) => paperlessService.renameTag(id, newName),
    delete: (id) => paperlessService.deleteTag(id),
    recreate: (name) => paperlessService.getOrCreateTag(name),
  },
  document_type: {
    kind: 'single-ref',  // doc has ONE document_type field
    listAll: () => paperlessService.listDocumentTypesWithCount(),
    docIdsForEntity: (id) => paperlessService.getDocumentIdsByDocumentType(id),
    bulkReassign: (docIds, targetId, _sourceId) => paperlessService.bulkSetDocumentType(docIds, targetId),
    rename: (id, newName) => paperlessService.renameDocumentType(id, newName),
    delete: (id) => paperlessService.deleteDocumentType(id),
    recreate: (name) => paperlessService.getOrCreateDocumentType(name),
  },
};

function getAdapter(entityType) {
  const adapter = ADAPTERS[entityType];
  if (!adapter) throw new Error(`Optimizer: unsupported entity type "${entityType}"`);
  return adapter;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const LEGAL_FORMS = [
  'gmbh & co. kg', 'gmbh & co kg', 'gmbh', 'aktiengesellschaft', 'ag', 'se',
  'kg', 'kgaa', 'ug', 'ohg', 'gbr', 'ev', 'e.v.', 'e.k.', 'ek',
  'ltd', 'ltd.', 'limited', 'inc', 'inc.', 'incorporated', 'llc', 'l.l.c.',
  'corp', 'corp.', 'corporation', 'co.', 'company',
  'sarl', 's.a.r.l.', 's.a.', 'sa', 'sas', 'nv', 'n.v.', 'bv', 'b.v.',
  'sl', 's.l.', 'srl', 's.r.l.', 'spa', 's.p.a.',
  'plc', 'p.l.c.',
];

const REGIONAL_SUFFIXES = [
  'deutschland', 'germany', 'europe', 'europa', 'international',
  'eu', 'de', 'uk', 'us', 'usa',
];

const TLD_PATTERN = /\.(de|com|net|org|eu|at|ch|io|co|uk|fr|it|es|nl|be)\b/gi;

function foldUmlauts(s) {
  return s
    .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
    .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
    .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
}

/**
 * Build a canonical key used for exact-match bucketing.
 */
function normalizeName(name) {
  let s = (name || '').toLowerCase();
  s = foldUmlauts(s);
  // strip TLDs
  s = s.replace(TLD_PATTERN, ' ');
  // normalize punctuation
  s = s.replace(/[._/,;:()\-+&'"]+/g, ' ');
  // tokenize
  let tokens = s.split(/\s+/).filter(Boolean);
  // drop legal forms & regional suffixes (anywhere in the name, not just trailing)
  const drop = new Set([...LEGAL_FORMS, ...REGIONAL_SUFFIXES]);
  tokens = tokens.filter(t => !drop.has(t));
  // also drop compound legal markers that survived (e.g. "co")
  tokens = tokens.filter(t => t !== 'co' && t !== 'und' && t !== 'and');
  return tokens.join(' ').trim();
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function levenshteinRatio(a, b) {
  if (!a.length && !b.length) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

function tokenSetRatio(a, b) {
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (!ta.size && !tb.size) return 1;
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

function similarity(a, b) {
  return Math.max(levenshteinRatio(a, b), tokenSetRatio(a, b));
}

// ---------------------------------------------------------------------------
// Clustering (union-find)
// ---------------------------------------------------------------------------

class DSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p[ra] = rb; }
}

/**
 * @param {Array<{id,name,document_count}>} entities
 * @param {{threshold?:number, ignoreSet?:Set<string>}} opts
 * @returns {Array<{clusterKey:string, members:Array}>}  only clusters with >=2 members
 */
function buildClusters(entities, { threshold = 0.85, ignoreSet = new Set() } = {}) {
  const n = entities.length;
  const norm = entities.map(e => normalizeName(e.name));
  const dsu = new DSU(n);

  // Step 1: exact-match grouping by normalized key (free, catches 80% of cases)
  const byKey = new Map();
  for (let i = 0; i < n; i++) {
    const k = norm[i];
    if (!k) continue; // entirely filtered out (e.g. "GmbH" alone)
    if (byKey.has(k)) dsu.union(byKey.get(k), i);
    else byKey.set(k, i);
  }

  // Step 2: fuzzy merge — O(n^2), ok for typical sizes (~hundreds to low thousands)
  for (let i = 0; i < n; i++) {
    if (!norm[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!norm[j]) continue;
      const lo = Math.min(entities[i].id, entities[j].id);
      const hi = Math.max(entities[i].id, entities[j].id);
      if (ignoreSet.has(`${lo}:${hi}`)) continue;
      const sim = similarity(norm[i], norm[j]);
      if (sim >= threshold) dsu.union(i, j);
    }
  }

  // Collect clusters
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = dsu.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const clusters = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // filter clusters that contain ignored pairs only (best-effort)
    const members = idxs.map(i => entities[i]);
    // Build a stable cluster key (sorted normalized tokens of the first member)
    const clusterKey = [...new Set(idxs.map(i => norm[i]).filter(Boolean))].sort().join('|');
    clusters.push({ clusterKey, members, normalizedKeys: idxs.map(i => norm[i]) });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Pipeline: analyze
// ---------------------------------------------------------------------------

async function analyze(entityType, { threshold = 0.85, useLlm = true, minDocuments = 0 } = {}) {
  const adapter = getAdapter(entityType);
  const all = await adapter.listAll();
  const filtered = minDocuments > 0 ? all.filter(e => (e.document_count || 0) >= minDocuments) : all;

  const ignoreSet = await db.optimizerGetIgnoreSet(entityType);
  const clusters = buildClusters(filtered, { threshold, ignoreSet });

  // Clear previous pending suggestions, re-populate from this run
  await db.optimizerClearPendingSuggestions(entityType);

  const results = [];
  for (const cluster of clusters) {
    // Fallback canonical: shortest member name
    let canonical = cluster.members
      .slice()
      .sort((a, b) => a.name.length - b.name.length)[0].name;
    let canonicalId = cluster.members.find(m => m.name === canonical)?.id || cluster.members[0].id;

    let llmResult = null;
    if (useLlm && cluster.members.length >= 2) {
      llmResult = await optimizerAi.verifyCluster(entityType, cluster.members.map(m => ({
        id: m.id,
        name: m.name,
        document_count: m.document_count,
      })));
      if (llmResult && !llmResult.error) {
        canonical = llmResult.canonical || canonical;
        // canonical might be a new name not in members -> fall back to most-used existing member
        const matchInCluster = cluster.members.find(m => m.name.toLowerCase() === canonical.toLowerCase());
        if (matchInCluster) canonicalId = matchInCluster.id;
      }
    }

    // If LLM says don't merge, skip — but still record so the UI can show "reviewed, not recommended"
    const status = (llmResult && llmResult.merge === false) ? 'rejected_by_llm' : 'pending';

    await db.optimizerUpsertSuggestion(
      entityType,
      cluster.clusterKey,
      canonical,
      canonicalId,
      cluster.members,
      llmResult ? llmResult.confidence : 0.5,
      llmResult ? llmResult.reason : 'Heuristische Übereinstimmung (kein LLM)',
      status
    );
    results.push({
      clusterKey: cluster.clusterKey,
      canonical,
      canonicalId,
      members: cluster.members,
      confidence: llmResult ? llmResult.confidence : 0.5,
      reason: llmResult ? llmResult.reason : 'Heuristische Übereinstimmung (kein LLM)',
      status,
      llmError: llmResult?.error || false,
    });
  }

  return {
    entityType,
    provider: optimizerAi.describeProvider(),
    totalEntities: all.length,
    clustersFound: clusters.length,
    suggestions: results,
  };
}

// ---------------------------------------------------------------------------
// Execute merge
// ---------------------------------------------------------------------------

/**
 * @param {'correspondent'} entityType
 * @param {object} payload
 *   { canonicalId, canonicalName, mergeIds: [int], dryRun: bool }
 */
async function executeMerge(entityType, { canonicalId, canonicalName, mergeIds, dryRun = true }) {
  const adapter = getAdapter(entityType);
  if (!canonicalId || !Array.isArray(mergeIds) || mergeIds.length === 0) {
    throw new Error('canonicalId und mindestens eine mergeId erforderlich');
  }
  if (mergeIds.includes(canonicalId)) {
    throw new Error('canonicalId darf nicht in mergeIds enthalten sein');
  }

  const affectedDocuments = [];
  const mergedEntities = [];

  // 1. Collect all documents pointing to the to-be-merged entities
  for (const srcId of mergeIds) {
    const docs = await adapter.docIdsForEntity(srcId);
    for (const d of docs) {
      affectedDocuments.push({ documentId: d.id, title: d.title, previousEntityId: srcId });
    }
    mergedEntities.push({ id: srcId });
  }

  if (dryRun) {
    const logId = await db.optimizerLogMerge(
      entityType, canonicalName, canonicalId, mergedEntities, affectedDocuments, true
    );
    return {
      dryRun: true,
      logId,
      canonicalId,
      canonicalName,
      affectedDocumentCount: affectedDocuments.length,
      mergedEntityCount: mergedEntities.length,
      sampleDocuments: affectedDocuments.slice(0, 20),
    };
  }

  // 2. Optionally rename canonical entity if name differs
  // (We look up the current name via adapter list; safer than guessing)
  const allEntities = await adapter.listAll();
  const canonicalCurrent = allEntities.find(e => e.id === canonicalId);
  if (canonicalCurrent && canonicalCurrent.name !== canonicalName) {
    await adapter.rename(canonicalId, canonicalName);
  }

  // 3. Reassign documents per source entity (bulk if possible)
  const bySource = new Map();
  affectedDocuments.forEach(d => {
    if (!bySource.has(d.previousEntityId)) bySource.set(d.previousEntityId, []);
    bySource.get(d.previousEntityId).push(d.documentId);
  });

  for (const [srcId, docIds] of bySource.entries()) {
    if (docIds.length > 0) {
      await adapter.bulkReassign(docIds, canonicalId, srcId);
    }
  }

  // 4. Delete merged entities
  const deletedOk = [];
  const deletedFail = [];
  for (const srcId of mergeIds) {
    const ok = await adapter.delete(srcId);
    (ok ? deletedOk : deletedFail).push(srcId);
  }

  // Enrich mergedEntities with original names for the log
  const byId = new Map(allEntities.map(e => [e.id, e.name]));
  const mergedEntitiesRich = mergedEntities.map(e => ({ ...e, name: byId.get(e.id) || `id ${e.id}` }));

  const logId = await db.optimizerLogMerge(
    entityType, canonicalName, canonicalId, mergedEntitiesRich, affectedDocuments, false
  );

  return {
    dryRun: false,
    logId,
    canonicalId,
    canonicalName,
    affectedDocumentCount: affectedDocuments.length,
    mergedEntityCount: mergedEntities.length,
    deleted: { ok: deletedOk, fail: deletedFail },
  };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Stellt einen Merge zurück.
 * Wichtig: die gelöschten Entitäten werden in Paperless neu angelegt (mit ursprünglichem Namen),
 * danach werden die Dokumente auf ihre ursprünglichen IDs zurückgesetzt — aber da die alten
 * IDs in Paperless nicht reserviert werden können, müssen wir zuordnen per neuem Objekt.
 *
 * Strategie: Für jedes ursprüngliche (id, name)-Paar einen neuen Korrespondenten erstellen
 * (via getOrCreateCorrespondent) und alle betroffenen Dokumente dorthin mappen.
 */
async function rollback(entityType, logId) {
  const adapter = getAdapter(entityType);
  const entry = await db.optimizerGetMergeLogEntry(logId);
  if (!entry) throw new Error(`Merge-Log-Eintrag ${logId} nicht gefunden`);
  if (entry.dry_run) throw new Error('Dry-Run-Einträge müssen nicht zurückgerollt werden');
  if (entry.rolled_back_at) throw new Error('Dieser Merge wurde bereits zurückgerollt');

  // Schritt 1: gelöschte Entitäten wieder anlegen (oder vorhandene finden)
  const oldIdToNewId = new Map();
  for (const merged of entry.merged_entities) {
    if (!merged.name) continue;
    const created = await adapter.recreate(merged.name);
    if (created && created.id) oldIdToNewId.set(merged.id, created.id);
  }

  // Schritt 2: Dokumente nach Quell-ID gruppieren
  const bySource = new Map();
  for (const aff of entry.affected_documents) {
    const newId = oldIdToNewId.get(aff.previousEntityId);
    if (!newId) continue;
    if (!bySource.has(newId)) bySource.set(newId, []);
    bySource.get(newId).push(aff.documentId);
  }

  // Schritt 3: Je nach Adapter-Typ restaurieren
  if (adapter.kind === 'single-ref') {
    // correspondent: Ziel-Feld auf die neue ID setzen (überschreibt canonical)
    for (const [newId, docIds] of bySource.entries()) {
      await adapter.bulkReassign(docIds, newId, entry.canonical_id);
    }
  } else if (adapter.kind === 'multi-ref') {
    // tag: neuen Tag hinzufügen (canonical bleibt dran — "weicher" Rollback,
    // kann danach ggf. per Optimizer nochmal aufgeräumt werden)
    for (const [newId, docIds] of bySource.entries()) {
      await adapter.bulkReassign(docIds, newId, null);
    }
  }

  await db.optimizerMarkMergeRolledBack(logId);

  return {
    logId,
    restoredEntities: [...oldIdToNewId.entries()].map(([oldId, newId]) => ({ oldId, newId })),
    restoredDocumentCount: entry.affected_documents.length,
    rollbackMode: adapter.kind,
  };
}

// ---------------------------------------------------------------------------
// Ignore list helpers
// ---------------------------------------------------------------------------

async function ignoreCluster(entityType, memberIds, memberNames = []) {
  // Add all pairs in the cluster to the ignore list so this grouping never re-appears
  for (let i = 0; i < memberIds.length; i++) {
    for (let j = i + 1; j < memberIds.length; j++) {
      await db.optimizerAddIgnore(
        entityType,
        memberIds[i], memberNames[i] || '',
        memberIds[j], memberNames[j] || ''
      );
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Saved-Views-Automatik für Steuerjahr
// ---------------------------------------------------------------------------

// Die 8 Kategorien + "Alle". Reihenfolge = Reihenfolge in Paperless-Sidebar.
const TAX_VIEW_DEFS = [
  { key: 'werbungskosten',            category: 'Werbungskosten',                   subtitle: 'Anlage N' },
  { key: 'betriebsausgabe',           category: 'Betriebsausgabe',                  subtitle: 'EÜR / Anlage S' },
  { key: 'sonderausgabe',             category: 'Sonderausgabe',                    subtitle: 'Anlage Vorsorgeaufwand' },
  { key: 'haushaltsnah',              category: 'Haushaltsnah',                     subtitle: '§35a EStG' },
  { key: 'aussergewoehnlichebelastung', category: 'AussergewoehnlicheBelastung',    subtitle: '§33 EStG' },
  { key: 'kapitaleinkuenfte',         category: 'Kapitaleinkuenfte',                subtitle: 'Anlage KAP' },
  { key: 'kinderbetreuung',           category: 'Kinderbetreuung',                  subtitle: '§10 Abs. 1 Nr. 5 EStG' },
  { key: 'schulgeld',                 category: 'Schulgeld',                        subtitle: '§10 Abs. 1 Nr. 9 EStG' },
  { key: 'vermietung',                category: 'Vermietung',                       subtitle: 'Anlage V' },
  { key: 'ausbildungsfreibetrag',     category: 'Ausbildungsfreibetrag',            subtitle: '§33a Abs. 2 EStG' },
];

/**
 * Legt 9 Saved Views für ein Steuerjahr in Paperless-NGX an:
 *  - Je eine pro Kategorie, gefiltert auf genau den Tag "<Kategorie> YYYY"
 *  - Eine Sammel-View "Steuer YYYY – Alle" mit allen vorhandenen Tags
 *
 * Überspringt Kategorien, für die kein passender Tag existiert (noch nicht
 * vergeben). Überspringt auch Views, die bereits angelegt sind (idempotent).
 *
 * @param {number|string} year  z.B. 2024
 * @param {object} opts
 *   @param {boolean} opts.showOnDashboard  Dashboard-Widget anlegen? (default false)
 *   @param {number|null} opts.ownerId  Owner (optional, null = alle sehen)
 */
async function createTaxSavedViews(year, { showOnDashboard = false, ownerId = null } = {}) {
  const yStr = String(year);
  if (!/^\d{4}$/.test(yStr)) throw new Error(`Ungültiges Jahr: ${year}`);

  const tags = await paperlessService.listTagsWithCount();
  const tagByName = new Map(tags.map(t => [t.name.toLowerCase(), t]));

  const existingViews = await paperlessService.listSavedViews();
  const existingByName = new Map(existingViews.map(v => [v.name.toLowerCase(), v]));

  const created = [];
  const skipped = [];
  const errors = [];
  const allTaxTagIds = [];

  for (const def of TAX_VIEW_DEFS) {
    const tagName = `${def.category} ${yStr}`;
    const tag = tagByName.get(tagName.toLowerCase());
    if (!tag) {
      skipped.push({ category: def.category, reason: `Tag "${tagName}" existiert noch nicht` });
      continue;
    }
    allTaxTagIds.push(tag.id);

    const viewName = `Steuer ${yStr} – ${def.category}`;
    if (existingByName.has(viewName.toLowerCase())) {
      skipped.push({ category: def.category, reason: `View "${viewName}" existiert bereits` });
      continue;
    }

    const payload = {
      name: viewName,
      show_on_dashboard: !!showOnDashboard,
      show_in_sidebar: true,
      sort_field: 'created',
      sort_reverse: false,
      filter_rules: [
        { rule_type: 6, value: String(tag.id) },  // has any of these tags
      ],
    };
    if (ownerId) payload.owner = ownerId;

    const res = await paperlessService.createSavedView(payload);
    if (res.ok) created.push({ category: def.category, viewId: res.view.id, viewName });
    else errors.push({ category: def.category, error: res.error, details: res.details });
  }

  // Sammel-View "Alle"
  if (allTaxTagIds.length > 0) {
    const allViewName = `Steuer ${yStr} – Alle`;
    if (!existingByName.has(allViewName.toLowerCase())) {
      const payload = {
        name: allViewName,
        show_on_dashboard: !!showOnDashboard,
        show_in_sidebar: true,
        sort_field: 'created',
        sort_reverse: false,
        filter_rules: [
          { rule_type: 6, value: allTaxTagIds.join(',') },
        ],
      };
      if (ownerId) payload.owner = ownerId;
      const res = await paperlessService.createSavedView(payload);
      if (res.ok) created.push({ category: 'ALLE', viewId: res.view.id, viewName: allViewName });
      else errors.push({ category: 'ALLE', error: res.error, details: res.details });
    } else {
      skipped.push({ category: 'ALLE', reason: `View "${allViewName}" existiert bereits` });
    }
  }

  return { year: yStr, created, skipped, errors };
}

// ---------------------------------------------------------------------------
// Tag-Wipe: komplettes Tag-Reset in Paperless-NGX
// ---------------------------------------------------------------------------

/**
 * Liefert eine Verteilungs-Statistik aller Tags:
 *   { total, orphans, bucket_1_2, bucket_3_10, bucket_11_plus, tags_sample }
 * Bucket-IDs gehen stets nach Dokumentanzahl.
 */
async function tagStatistics() {
  const tags = await paperlessService.listTagsWithCount();
  const buckets = { orphans: 0, bucket_1_2: 0, bucket_3_10: 0, bucket_11_plus: 0 };
  for (const t of tags) {
    const c = t.document_count || 0;
    if (c === 0) buckets.orphans++;
    else if (c <= 2) buckets.bucket_1_2++;
    else if (c <= 10) buckets.bucket_3_10++;
    else buckets.bucket_11_plus++;
  }
  // Stichprobe: 10 häufigste + 10 seltenste (ohne 0er)
  const sorted = tags.slice().sort((a, b) => (b.document_count || 0) - (a.document_count || 0));
  const top = sorted.slice(0, 10).map(t => ({ name: t.name, count: t.document_count || 0 }));
  const rareNonZero = sorted.filter(t => (t.document_count || 0) > 0).slice(-10).map(t => ({ name: t.name, count: t.document_count || 0 }));
  return {
    total: tags.length,
    ...buckets,
    top,
    rare: rareNonZero,
  };
}

/**
 * Löscht Tags die auf keinem einzigen Dokument vergeben sind.
 * Risikolos, weil keine Dokumenten-Daten verändert werden.
 */
async function deleteOrphanTags() {
  const tags = await paperlessService.listTagsWithCount();
  const orphans = tags.filter(t => (t.document_count || 0) === 0);
  const deleted = [];
  const failed = [];
  for (const t of orphans) {
    const ok = await paperlessService.deleteTag(t.id);
    (ok ? deleted : failed).push({ id: t.id, name: t.name });
  }
  return { scanned: tags.length, orphansFound: orphans.length, deleted: deleted.length, failed: failed.length, failedList: failed };
}

/**
 * Komplettes Tag-Wipe: entfernt ALLE Tags von ALLEN Dokumenten. Optional werden
 * zusätzlich alle Tag-Definitionen in Paperless gelöscht.
 *
 * @param {object} opts
 *   @param {boolean} opts.deleteDefinitions  Auch die Tag-Definitionen löschen
 *   @param {boolean} opts.keepManualSystemTags  Systemtags wie "inbox" behalten
 *   @param {string[]} opts.preserveNames  Namen von Tags die erhalten bleiben sollen (z.B. ai-processed)
 * @returns Backup-Object mit vollständiger Liste aller Tag-Zuweisungen für potenzielles Undo
 */
async function wipeAllTags({ deleteDefinitions = false, preserveNames = [] } = {}) {
  const preserveSet = new Set(preserveNames.map(n => n.toLowerCase()));
  const allTags = await paperlessService.listTagsWithCount();
  const targetTags = allTags.filter(t => !preserveSet.has((t.name || '').toLowerCase()));
  const preservedTags = allTags.filter(t => preserveSet.has((t.name || '').toLowerCase()));

  // Backup: pro Dokument alle Tag-IDs erfassen — für potenzielles Undo.
  // ACHTUNG: diese Liste kann sehr groß werden, wir loggen sie in der Konsole
  // und geben sie auch im Response zurück.
  const backup = [];
  const affectedDocIds = new Set();

  // Für jeden Target-Tag: alle Dokumente holen und Tag entfernen
  const perTagStats = [];
  for (const tag of targetTags) {
    const docs = await paperlessService.getDocumentIdsByTag(tag.id);
    docs.forEach(d => {
      affectedDocIds.add(d.id);
      backup.push({ documentId: d.id, tagId: tag.id, tagName: tag.name });
    });
    if (docs.length > 0) {
      await paperlessService.bulkModifyTags(docs.map(d => d.id), [], [tag.id]);
    }
    perTagStats.push({ id: tag.id, name: tag.name, documentsAffected: docs.length });
  }

  // Optional: Tag-Definitionen löschen
  let definitionsDeleted = 0;
  if (deleteDefinitions) {
    for (const tag of targetTags) {
      const ok = await paperlessService.deleteTag(tag.id);
      if (ok) definitionsDeleted++;
    }
  }

  return {
    ok: true,
    tagsProcessed: targetTags.length,
    tagsPreserved: preservedTags.map(t => ({ id: t.id, name: t.name })),
    documentsAffected: affectedDocIds.size,
    definitionsDeleted,
    backupSize: backup.length,
    backup,  // JSON für Download / Re-Import wenn etwas schief ging
  };
}

// ---------------------------------------------------------------------------
// Document-Type Wipe
// ---------------------------------------------------------------------------

async function documentTypeStatistics() {
  const list = await paperlessService.listDocumentTypesWithCount();
  const buckets = { orphans: 0, bucket_1_2: 0, bucket_3_10: 0, bucket_11_plus: 0 };
  for (const t of list) {
    const c = t.document_count || 0;
    if (c === 0) buckets.orphans++;
    else if (c <= 2) buckets.bucket_1_2++;
    else if (c <= 10) buckets.bucket_3_10++;
    else buckets.bucket_11_plus++;
  }
  const sorted = list.slice().sort((a, b) => (b.document_count || 0) - (a.document_count || 0));
  const top = sorted.slice(0, 10).map(t => ({ name: t.name, count: t.document_count || 0 }));
  const rare = sorted.filter(t => (t.document_count || 0) > 0).slice(-10).map(t => ({ name: t.name, count: t.document_count || 0 }));
  return { total: list.length, ...buckets, top, rare };
}

async function deleteOrphanDocumentTypes() {
  const list = await paperlessService.listDocumentTypesWithCount();
  const orphans = list.filter(t => (t.document_count || 0) === 0);
  const deleted = [];
  const failed = [];
  for (const t of orphans) {
    const ok = await paperlessService.deleteDocumentType(t.id);
    (ok ? deleted : failed).push({ id: t.id, name: t.name });
  }
  return {
    scanned: list.length,
    orphansFound: orphans.length,
    deleted: deleted.length,
    failed: failed.length,
    failedList: failed,
  };
}

/**
 * Komplett-Wipe der Dokumenttypen:
 *  1. Auf jedem Dokument document_type auf null setzen
 *  2. Optional alle Document-Type-Definitionen löschen
 * Backup enthält pro Dokument die vorher gesetzte Type-ID — damit könnte man
 * einen Undo skripten.
 */
async function wipeAllDocumentTypes({ deleteDefinitions = false, preserveNames = [] } = {}) {
  const preserveSet = new Set(preserveNames.map(n => n.toLowerCase()));
  const all = await paperlessService.listDocumentTypesWithCount();
  const targets = all.filter(t => !preserveSet.has((t.name || '').toLowerCase()));
  const preserved = all.filter(t => preserveSet.has((t.name || '').toLowerCase()));

  const backup = [];
  const affectedDocIds = new Set();
  const perTypeStats = [];

  for (const t of targets) {
    const docs = await paperlessService.getDocumentIdsByDocumentType(t.id);
    docs.forEach(d => {
      affectedDocIds.add(d.id);
      backup.push({ documentId: d.id, documentTypeId: t.id, documentTypeName: t.name });
    });
    // Alle diese Docs: document_type auf null setzen (per Dokument, kein Bulk-Endpoint
    // "clear document_type" in Paperless verfügbar — gehen wir per Einzel-PATCH)
    for (const d of docs) {
      await paperlessService.clearDocumentType(d.id);
    }
    perTypeStats.push({ id: t.id, name: t.name, documentsAffected: docs.length });
  }

  let definitionsDeleted = 0;
  if (deleteDefinitions) {
    for (const t of targets) {
      const ok = await paperlessService.deleteDocumentType(t.id);
      if (ok) definitionsDeleted++;
    }
  }

  return {
    ok: true,
    typesProcessed: targets.length,
    typesPreserved: preserved.map(t => ({ id: t.id, name: t.name })),
    documentsAffected: affectedDocIds.size,
    definitionsDeleted,
    backupSize: backup.length,
    backup,
  };
}

module.exports = {
  analyze,
  executeMerge,
  rollback,
  ignoreCluster,
  createTaxSavedViews,
  tagStatistics,
  deleteOrphanTags,
  wipeAllTags,
  documentTypeStatistics,
  deleteOrphanDocumentTypes,
  wipeAllDocumentTypes,
  // exported for unit testing
  _internal: { normalizeName, similarity, buildClusters, TAX_VIEW_DEFS },
};
