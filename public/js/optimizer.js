// public/js/optimizer.js
// Client logic for the Entity Optimizer page.

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- Theme toggle (copied from existing pages) ----------
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    const saved = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    });
  }

  // ---------- Tab switching ----------
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-tab');
      $$('.tab-panel').forEach(p => p.classList.add('hidden'));
      $(`#tab-${target}`).classList.remove('hidden');
      if (target === 'history') loadHistory();
      if (target === 'ignore') loadIgnores();
      if (target === 'maintenance') loadMaintenanceStatus();
    });
  });

  // ---------- Toasts ----------
  function toast(message, type = 'info') {
    const area = $('#toastArea');
    const el = document.createElement('div');
    const colors = {
      info: 'bg-blue-600',
      success: 'bg-green-600',
      error: 'bg-red-600',
      warn: 'bg-yellow-600',
    };
    el.className = `${colors[type] || colors.info} text-white px-4 py-2 rounded-md shadow-lg text-sm max-w-sm`;
    el.textContent = message;
    area.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 300ms'; }, 3500);
    setTimeout(() => el.remove(), 3900);
  }

  // ---------- API helper ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) {
      toast('Nicht eingeloggt — Seite wird neu geladen.', 'warn');
      setTimeout(() => { window.location.href = '/login'; }, 1500);
      throw new Error('unauthenticated');
    }
    if (!res.ok) {
      let err = '';
      try { err = (await res.json()).error || res.statusText; } catch { err = res.statusText; }
      throw new Error(err);
    }
    return res.json();
  }

  // ---------- Provider badge ----------
  async function loadProvider() {
    try {
      const p = await api('/api/optimizer/provider');
      $('#providerBadge').innerHTML = `<i class="fa-solid fa-robot mr-1"></i> ${p.provider} · ${p.model}`;
    } catch (e) {
      $('#providerBadge').innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> Provider-Info nicht verfügbar`;
    }
  }

  // ---------- Analysis ----------

  const stateCurrent = { suggestions: [] };

  async function runAnalysis() {
    const body = {
      entityType: $('#entityType').value,
      threshold: parseFloat($('#threshold').value) || 0.85,
      minDocuments: parseInt($('#minDocuments').value, 10) || 0,
      useLlm: $('#useLlm').checked,
    };

    $('#analysisStatus').classList.remove('hidden');
    $('#analysisStatus').innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Analyse läuft — je nach Provider und Korrespondenten-Anzahl dauert das 10–60 Sekunden.';
    $('#clustersContainer').innerHTML = '';

    try {
      const result = await api('/api/optimizer/analyze', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      $('#analysisStatus').innerHTML =
        `<strong>${result.totalEntities}</strong> Entitäten geprüft, ` +
        `<strong>${result.clustersFound}</strong> Cluster gefunden. ` +
        `<span class="text-text-secondary">Provider: ${result.provider?.provider || '?'} / ${result.provider?.model || '?'}</span>`;
      stateCurrent.suggestions = result.suggestions || [];
      renderClusters(stateCurrent.suggestions, body.entityType);
    } catch (e) {
      $('#analysisStatus').innerHTML = `<span class="text-red-600">Fehler: ${e.message}</span>`;
      toast(`Analyse fehlgeschlagen: ${e.message}`, 'error');
    }
  }

  async function loadCached() {
    const entityType = $('#entityType').value;
    try {
      const result = await api(`/api/optimizer/suggestions?entityType=${encodeURIComponent(entityType)}`);
      if (!result.suggestions.length) {
        $('#analysisStatus').classList.remove('hidden');
        $('#analysisStatus').textContent = 'Kein zwischengespeichertes Ergebnis — bitte Analyse starten.';
        $('#clustersContainer').innerHTML = '';
        return;
      }
      // Map cached rows into the same shape analyze() returns
      const mapped = result.suggestions.map(s => ({
        suggestionId: s.id,
        clusterKey: s.cluster_key,
        canonical: s.canonical_name,
        canonicalId: s.canonical_id,
        members: s.members,
        confidence: s.confidence,
        reason: s.reason,
        status: s.status,
      }));
      stateCurrent.suggestions = mapped;
      $('#analysisStatus').classList.remove('hidden');
      $('#analysisStatus').textContent = `${mapped.length} zwischengespeicherte Cluster geladen.`;
      renderClusters(mapped, entityType);
    } catch (e) {
      toast(`Laden fehlgeschlagen: ${e.message}`, 'error');
    }
  }

  function renderClusters(suggestions, entityType) {
    const container = $('#clustersContainer');
    container.innerHTML = '';
    if (!suggestions.length) {
      container.innerHTML = '<div class="text-text-secondary p-4">Keine Cluster gefunden.</div>';
      return;
    }
    suggestions.forEach((s, idx) => container.appendChild(renderClusterCard(s, idx, entityType)));
  }

  function renderClusterCard(cluster, idx, entityType) {
    const card = document.createElement('div');
    card.className = 'border border-border-color rounded-lg p-4 bg-bg-primary';

    const totalDocs = (cluster.members || []).reduce((acc, m) => acc + (m.document_count || 0), 0);
    const confPct = Math.round((cluster.confidence || 0) * 100);
    const confColor = confPct >= 85 ? 'text-green-600' : confPct >= 65 ? 'text-yellow-600' : 'text-red-600';
    const statusBadge = cluster.status === 'rejected_by_llm'
      ? '<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">LLM rät ab</span>'
      : cluster.status === 'merged'
      ? '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Gemerged</span>'
      : cluster.status === 'ignored'
      ? '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">Ignoriert</span>'
      : '';

    card.innerHTML = `
      <div class="flex items-start justify-between gap-4 mb-3">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <label class="text-xs text-text-secondary">Ziel-Name:</label>
            <input data-role="canonical" type="text" value="${escapeHtml(cluster.canonical || '')}"
                   class="rounded-md border-border-color bg-bg-secondary text-text-primary p-1 text-sm flex-1 max-w-md" />
            ${statusBadge}
          </div>
          <div class="text-xs text-text-secondary">
            ${cluster.members.length} Entitäten · ${totalDocs} Dokumente insgesamt ·
            Confidence: <span class="${confColor} font-semibold">${confPct}%</span>
          </div>
          <div class="text-xs text-text-secondary italic mt-1">${escapeHtml(cluster.reason || '')}</div>
        </div>
      </div>

      <table class="w-full text-sm mb-3">
        <thead>
          <tr class="text-left text-xs text-text-secondary border-b border-border-color">
            <th class="py-1 w-10">Ziel</th>
            <th class="py-1 w-10">Merge</th>
            <th class="py-1">Name</th>
            <th class="py-1 text-right w-24">Dokumente</th>
          </tr>
        </thead>
        <tbody>
          ${cluster.members.map(m => `
            <tr class="border-b border-border-color" data-id="${m.id}">
              <td class="py-1"><input type="radio" name="canonical-${idx}" ${m.id === cluster.canonicalId ? 'checked' : ''} data-role="pick-canonical"></td>
              <td class="py-1"><input type="checkbox" data-role="merge-member" ${m.id !== cluster.canonicalId ? 'checked' : ''}></td>
              <td class="py-1">${escapeHtml(m.name)}</td>
              <td class="py-1 text-right">${m.document_count ?? 0}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="flex flex-wrap gap-2">
        <button data-role="preview" class="px-3 py-1 rounded-md border border-border-color text-sm">
          <i class="fa-solid fa-eye mr-1"></i> Dry-Run
        </button>
        <button data-role="merge" class="px-3 py-1 rounded-md bg-green-600 text-white text-sm">
          <i class="fa-solid fa-code-merge mr-1"></i> Merge ausführen
        </button>
        <button data-role="ignore" class="px-3 py-1 rounded-md border border-border-color text-sm">
          <i class="fa-solid fa-eye-slash mr-1"></i> Dauerhaft ignorieren
        </button>
      </div>
      <div data-role="result" class="mt-3 text-sm"></div>
    `;

    // wire up radio -> canonicalId swap + auto-check / uncheck
    card.querySelectorAll('tr[data-id]').forEach(row => {
      const id = parseInt(row.getAttribute('data-id'), 10);
      const pick = row.querySelector('[data-role=pick-canonical]');
      const merge = row.querySelector('[data-role=merge-member]');
      pick.addEventListener('change', () => {
        if (pick.checked) {
          cluster.canonicalId = id;
          // canonical itself cannot be in mergeIds
          merge.checked = false;
          // enable others
          card.querySelectorAll('tr[data-id]').forEach(r => {
            if (parseInt(r.getAttribute('data-id'), 10) !== id) {
              const cb = r.querySelector('[data-role=merge-member]');
              cb.disabled = false;
            }
          });
          merge.disabled = true;
        }
      });
    });

    card.querySelector('[data-role=preview]').addEventListener('click', () => doMerge(card, cluster, entityType, true));
    card.querySelector('[data-role=merge]').addEventListener('click', () => doMerge(card, cluster, entityType, false));
    card.querySelector('[data-role=ignore]').addEventListener('click', () => doIgnore(card, cluster, entityType));

    return card;
  }

  function collectCard(card, cluster) {
    const canonical = card.querySelector('[data-role=canonical]').value.trim();
    const rows = Array.from(card.querySelectorAll('tr[data-id]'));
    let canonicalId = cluster.canonicalId;
    const mergeIds = [];
    rows.forEach(r => {
      const id = parseInt(r.getAttribute('data-id'), 10);
      if (r.querySelector('[data-role=pick-canonical]').checked) canonicalId = id;
      if (r.querySelector('[data-role=merge-member]').checked) mergeIds.push(id);
    });
    const memberIds = rows.map(r => parseInt(r.getAttribute('data-id'), 10));
    const memberNames = cluster.members.map(m => m.name);
    return { canonical, canonicalId, mergeIds, memberIds, memberNames };
  }

  async function doMerge(card, cluster, entityType, dryRun) {
    const picked = collectCard(card, cluster);
    if (!picked.canonical) { toast('Ziel-Name fehlt.', 'warn'); return; }
    if (!picked.mergeIds.length) { toast('Keine Duplikate markiert.', 'warn'); return; }
    if (picked.mergeIds.includes(picked.canonicalId)) {
      toast('Ziel-Entität kann nicht gleichzeitig Quelle sein.', 'warn');
      return;
    }
    if (!dryRun && !confirm(`Wirklich ${picked.mergeIds.length} Entität(en) in "${picked.canonical}" mergen? Alle zugeordneten Dokumente werden umgehängt und die Duplikat-Einträge werden gelöscht.`)) {
      return;
    }
    card.querySelector('[data-role=result]').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> läuft…';
    try {
      const body = {
        entityType,
        canonicalId: picked.canonicalId,
        canonicalName: picked.canonical,
        mergeIds: picked.mergeIds,
        dryRun,
        suggestionId: cluster.suggestionId || null,
      };
      const result = await api('/api/optimizer/merge', { method: 'POST', body: JSON.stringify(body) });
      if (dryRun) {
        card.querySelector('[data-role=result]').innerHTML =
          `<div class="p-2 rounded bg-bg-secondary"><strong>Dry-Run:</strong> ${result.affectedDocumentCount} Dokumente würden auf "${escapeHtml(picked.canonical)}" umgehängt; ${result.mergedEntityCount} Entität(en) würden gelöscht.</div>`;
      } else {
        card.querySelector('[data-role=result]').innerHTML =
          `<div class="p-2 rounded bg-green-100 text-green-800"><strong>Merge abgeschlossen.</strong> ${result.affectedDocumentCount} Dokumente umgehängt. Gelöscht: ${(result.deleted?.ok || []).length}. Log-ID: ${result.logId}</div>`;
        toast('Merge erfolgreich.', 'success');
      }
    } catch (e) {
      card.querySelector('[data-role=result]').innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">Fehler: ${escapeHtml(e.message)}</div>`;
      toast(`Merge fehlgeschlagen: ${e.message}`, 'error');
    }
  }

  async function doIgnore(card, cluster, entityType) {
    const picked = collectCard(card, cluster);
    if (!confirm(`Diese ${picked.memberIds.length} Entitäten dauerhaft als "nicht zusammenführen" markieren?`)) return;
    try {
      await api('/api/optimizer/ignore', {
        method: 'POST',
        body: JSON.stringify({
          entityType,
          memberIds: picked.memberIds,
          memberNames: picked.memberNames,
          suggestionId: cluster.suggestionId || null,
        }),
      });
      card.style.opacity = '0.5';
      card.querySelector('[data-role=result]').innerHTML = '<div class="p-2 rounded bg-gray-200 text-gray-700">Auf Ignorier-Liste gesetzt.</div>';
      toast('Auf Ignorier-Liste gesetzt.', 'success');
    } catch (e) {
      toast(`Fehler: ${e.message}`, 'error');
    }
  }

  // ---------- History ----------

  async function loadHistory() {
    const box = $('#historyContainer');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> lade…';
    try {
      const res = await api('/api/optimizer/history');
      if (!res.history.length) {
        box.innerHTML = '<div class="text-text-secondary p-4">Noch keine Merges durchgeführt.</div>';
        return;
      }
      box.innerHTML = '';
      res.history.forEach(h => {
        const div = document.createElement('div');
        const date = new Date(h.created_at).toLocaleString('de-DE');
        const rolled = h.rolled_back_at
          ? `<span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">Zurückgerollt ${new Date(h.rolled_back_at).toLocaleString('de-DE')}</span>`
          : '';
        const dry = h.dry_run
          ? '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Dry-Run</span>'
          : '';
        div.className = 'border border-border-color rounded-lg p-3 bg-bg-primary';
        div.innerHTML = `
          <div class="flex justify-between items-start">
            <div>
              <div class="font-semibold">${escapeHtml(h.canonical_name)} <span class="text-xs text-text-secondary">(${h.entity_type})</span> ${dry} ${rolled}</div>
              <div class="text-xs text-text-secondary">${date} · ${h.affected_documents.length} Dokumente · ${h.merged_entities.length} Entitäten gemerged</div>
              <details class="mt-1">
                <summary class="text-xs text-text-secondary cursor-pointer">Details</summary>
                <div class="text-xs mt-1">
                  <div><strong>Merged:</strong> ${h.merged_entities.map(e => escapeHtml(e.name || `id ${e.id}`)).join(', ')}</div>
                </div>
              </details>
            </div>
            <div>
              ${!h.dry_run && !h.rolled_back_at
                ? `<button data-role="rollback" data-id="${h.id}" class="px-3 py-1 rounded-md bg-red-600 text-white text-sm">
                     <i class="fa-solid fa-rotate-left mr-1"></i> Rollback
                   </button>`
                : ''}
            </div>
          </div>
        `;
        const btn = div.querySelector('[data-role=rollback]');
        if (btn) btn.addEventListener('click', () => doRollback(h.id));
        box.appendChild(div);
      });
    } catch (e) {
      box.innerHTML = `<div class="text-red-600">Fehler: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function doRollback(id) {
    if (!confirm('Wirklich zurückrollen? Gelöschte Korrespondenten werden neu angelegt und Dokumente zurückgehängt.')) return;
    try {
      const res = await api(`/api/optimizer/rollback/${id}`, { method: 'POST' });
      toast(`Rollback erfolgreich. ${res.restoredDocumentCount} Dokumente wiederhergestellt.`, 'success');
      loadHistory();
    } catch (e) {
      toast(`Rollback fehlgeschlagen: ${e.message}`, 'error');
    }
  }

  // ---------- Ignore list ----------

  async function loadIgnores() {
    const box = $('#ignoreContainer');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> lade…';
    try {
      const res = await api(`/api/optimizer/ignore?entityType=${encodeURIComponent($('#entityType').value)}`);
      if (!res.ignores.length) {
        box.innerHTML = '<div class="text-text-secondary p-4">Keine ignorierten Paare.</div>';
        return;
      }
      box.innerHTML = '';
      res.ignores.forEach(ig => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between border border-border-color rounded-lg p-2 bg-bg-primary';
        div.innerHTML = `
          <div class="text-sm">
            <span class="font-medium">${escapeHtml(ig.name_a || `id ${ig.entity_id_a}`)}</span>
            <i class="fa-solid fa-arrow-right-arrow-left text-xs text-text-secondary mx-2"></i>
            <span class="font-medium">${escapeHtml(ig.name_b || `id ${ig.entity_id_b}`)}</span>
          </div>
          <button data-id="${ig.id}" class="px-3 py-1 rounded-md border border-border-color text-sm">
            <i class="fa-solid fa-trash mr-1"></i> Entfernen
          </button>
        `;
        div.querySelector('button').addEventListener('click', async () => {
          try {
            await api(`/api/optimizer/ignore/${ig.id}`, { method: 'DELETE' });
            toast('Entfernt.', 'success');
            loadIgnores();
          } catch (e) {
            toast(`Fehler: ${e.message}`, 'error');
          }
        });
        box.appendChild(div);
      });
    } catch (e) {
      box.innerHTML = `<div class="text-red-600">Fehler: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- Maintenance ----------

  async function loadMaintenanceStatus() {
    const cells = $('#maintenanceStatus').querySelectorAll('div.border > div');
    try {
      const status = await api('/api/optimizer/maintenance/status');
      if (cells[0]) {
        cells[0].innerHTML = `
          <div class="text-sm space-y-1">
            <div>Dokumente: <strong>${status.paperless.documents}</strong></div>
            <div>Korrespondenten: <strong>${status.paperless.correspondents}</strong></div>
            <div>Tags: <strong>${status.paperless.tags}</strong></div>
          </div>`;
      }
      if (cells[1]) {
        const diffClass = status.tracking.diff === 0 ? 'text-green-600' : 'text-yellow-600';
        const diffSign = status.tracking.diff >= 0 ? '+' : '';
        cells[1].innerHTML = `
          <div class="text-sm space-y-1">
            <div>Verarbeitete Dokumente: <strong>${status.tracking.processed}</strong></div>
            <div>Getrackte IDs: <strong>${status.tracking.tracked_ids}</strong></div>
            <div>Differenz: <strong class="${diffClass}">${diffSign}${status.tracking.diff}</strong>
              ${status.tracking.diff !== 0 ? '<span class="text-xs text-text-secondary"> (sollte 0 sein)</span>' : ''}
            </div>
          </div>`;
      }
    } catch (e) {
      if (cells[0]) cells[0].innerHTML = `<div class="text-red-600 text-sm">${escapeHtml(e.message)}</div>`;
      if (cells[1]) cells[1].innerHTML = `<div class="text-red-600 text-sm">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runPruneOrphans() {
    const box = $('#pruneOrphansResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> scanne und bereinige…';
    try {
      const r = await api('/api/optimizer/maintenance/prune-orphans', { method: 'POST' });
      box.innerHTML = `<div class="p-2 rounded bg-white border border-yellow-300">
        <strong>${r.deleted}</strong> Waisen entfernt, ${r.scanned} Dokumente in Paperless geprüft.
        ${r.orphans?.length ? `<details class="mt-1"><summary class="cursor-pointer text-xs">IDs anzeigen</summary><div class="text-xs mt-1">${r.orphans.join(', ')}</div></details>` : ''}
      </div>`;
      toast('Waisen aufgeräumt.', 'success');
      loadMaintenanceStatus();
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runResetTracking() {
    if (!confirm('Wirklich ALLE Verarbeitungs-Markierungen zurücksetzen? Beim nächsten Scan werden alle Dokumente erneut von der KI analysiert. Das kann einige Zeit dauern und LLM-Kosten verursachen.')) return;
    const box = $('#resetTrackingResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> setze zurück…';
    try {
      const r = await api('/api/optimizer/maintenance/reset-tracking', { method: 'POST' });
      if (r.ok) {
        box.innerHTML = `<div class="p-2 rounded bg-white border border-red-300">
          <strong>${r.cleared}</strong> Tracking-Einträge gelöscht. Der nächste Paperless-AI-Scan wird alle Dokumente neu analysieren.
          <div class="text-xs mt-1 text-text-secondary">Falls Paperless-AI den "ai-processed"-Tag setzt, musst du den in Paperless-NGX ggf. auch manuell entfernen, damit die Dokumente neu erfasst werden.</div>
        </div>`;
        toast('Reset erfolgreich.', 'success');
        loadMaintenanceStatus();
      } else {
        box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">Fehler: ${escapeHtml(r.error || 'unknown')}</div>`;
      }
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

async function runTagStats() {
    const box = $('#tagStatsBox');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> analysiere…';
    try {
      const s = await api('/api/optimizer/maintenance/tag-stats');
      const renderList = (arr) => arr.map(t => `<li><code>${escapeHtml(t.name)}</code> <span class="text-text-secondary">(${t.count})</span></li>`).join('');
      box.innerHTML = `
        <div class="p-3 rounded bg-white border border-purple-300 text-sm">
          <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
            <div><div class="text-xs text-text-secondary">Gesamt</div><div class="text-xl font-bold">${s.total}</div></div>
            <div><div class="text-xs text-text-secondary">0 Dokumente</div><div class="text-xl font-bold text-purple-700">${s.orphans}</div></div>
            <div><div class="text-xs text-text-secondary">1-2 Docs</div><div class="text-xl font-bold">${s.bucket_1_2}</div></div>
            <div><div class="text-xs text-text-secondary">3-10 Docs</div><div class="text-xl font-bold">${s.bucket_3_10}</div></div>
            <div><div class="text-xs text-text-secondary">11+ Docs</div><div class="text-xl font-bold">${s.bucket_11_plus}</div></div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <div class="font-semibold mb-1">Top 10 meistgenutzt:</div>
              <ul class="list-disc list-inside space-y-0.5">${renderList(s.top)}</ul>
            </div>
            <div>
              <div class="font-semibold mb-1">10 seltenste (mit &ge;1 Dokument):</div>
              <ul class="list-disc list-inside space-y-0.5">${renderList(s.rare)}</ul>
            </div>
          </div>
        </div>`;
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runDeleteOrphans() {
    if (!confirm('Wirklich alle Tags ohne Dokumentenzuordnung aus Paperless-NGX löschen? (Tag-Definitionen werden entfernt, Dokumente bleiben unberührt.)')) return;
    const box = $('#deleteOrphanTagsResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> lösche…';
    try {
      const r = await api('/api/optimizer/maintenance/delete-orphan-tags', { method: 'POST' });
      box.innerHTML = `<div class="p-2 rounded bg-white border border-purple-300">
        <strong>${r.deleted}</strong> verwaiste Tags gelöscht (von ${r.orphansFound} gefunden, ${r.scanned} Tags gesamt geprüft).
        ${r.failed > 0 ? `<div class="text-xs text-red-700 mt-1">${r.failed} Fehler — siehe Container-Log.</div>` : ''}
      </div>`;
      toast(`${r.deleted} verwaiste Tags gelöscht.`, 'success');
      runTagStats();
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runWipeAllTags() {
    const preserveRaw = $('#wipePreserveNames').value || '';
    const preserveNames = preserveRaw.split(',').map(s => s.trim()).filter(Boolean);
    const deleteDefinitions = $('#wipeDeleteDefs').checked;
    const confirmMsg = `ACHTUNG: Das entfernt ALLE Tags von ALLEN Dokumenten in Paperless-NGX${deleteDefinitions ? ' UND löscht die Tag-Definitionen' : ''}.\n\n` +
                       `Geschützt bleiben: ai-processed${preserveNames.length ? ', ' + preserveNames.join(', ') : ''}\n\n` +
                       `Ein JSON-Backup wird im Container-Log hinterlegt.\n\n` +
                       `Bist du sicher?`;
    if (!confirm(confirmMsg)) return;
    if (!confirm('Letzte Bestätigung — es gibt KEINEN Undo-Button für diese Aktion. Fortfahren?')) return;
    const box = $('#wipeAllTagsResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> wipe läuft — kann bei vielen Tags einige Minuten dauern…';
    try {
      const r = await api('/api/optimizer/maintenance/wipe-all-tags', {
        method: 'POST',
        body: JSON.stringify({ deleteDefinitions, preserveNames }),
      });
      box.innerHTML = `<div class="p-3 rounded bg-white border border-red-300">
        <div class="font-semibold mb-1">Wipe abgeschlossen.</div>
        <ul class="text-xs list-disc list-inside">
          <li>Bearbeitete Tags: <strong>${r.tagsProcessed}</strong></li>
          <li>Betroffene Dokumente: <strong>${r.documentsAffected}</strong></li>
          <li>Tag-Definitionen gelöscht: <strong>${r.definitionsDeleted}</strong></li>
          <li>Geschützt: ${r.tagsPreserved.map(t => `<code>${escapeHtml(t.name)}</code>`).join(', ') || '(keine)'}</li>
          <li>Backup-Einträge im Log: <strong>${r.backupSize || 0}</strong></li>
        </ul>
      </div>`;
      toast('Tag-Wipe abgeschlossen.', 'success');
      runTagStats();
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- Document Type wipe (analog zu Tags) ----------

  async function runDocTypeStats() {
    const box = $('#docTypeStatsBox');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> analysiere…';
    try {
      const s = await api('/api/optimizer/maintenance/document-type-stats');
      const renderList = (arr) => arr.map(t => `<li><code>${escapeHtml(t.name)}</code> <span class="text-text-secondary">(${t.count})</span></li>`).join('');
      box.innerHTML = `
        <div class="p-3 rounded bg-white border border-indigo-300 text-sm">
          <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
            <div><div class="text-xs text-text-secondary">Gesamt</div><div class="text-xl font-bold">${s.total}</div></div>
            <div><div class="text-xs text-text-secondary">0 Dokumente</div><div class="text-xl font-bold text-indigo-700">${s.orphans}</div></div>
            <div><div class="text-xs text-text-secondary">1-2 Docs</div><div class="text-xl font-bold">${s.bucket_1_2}</div></div>
            <div><div class="text-xs text-text-secondary">3-10 Docs</div><div class="text-xl font-bold">${s.bucket_3_10}</div></div>
            <div><div class="text-xs text-text-secondary">11+ Docs</div><div class="text-xl font-bold">${s.bucket_11_plus}</div></div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <div class="font-semibold mb-1">Top 10 meistgenutzt:</div>
              <ul class="list-disc list-inside space-y-0.5">${renderList(s.top)}</ul>
            </div>
            <div>
              <div class="font-semibold mb-1">10 seltenste (≥1 Dokument):</div>
              <ul class="list-disc list-inside space-y-0.5">${renderList(s.rare)}</ul>
            </div>
          </div>
        </div>`;
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runDeleteOrphanDocTypes() {
    if (!confirm('Wirklich alle Dokumenttypen ohne Zuordnung löschen?')) return;
    const box = $('#deleteOrphanDocTypesResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> lösche…';
    try {
      const r = await api('/api/optimizer/maintenance/delete-orphan-document-types', { method: 'POST' });
      box.innerHTML = `<div class="p-2 rounded bg-white border border-indigo-300">
        <strong>${r.deleted}</strong> verwaiste Dokumenttypen gelöscht (von ${r.orphansFound}, ${r.scanned} geprüft).
        ${r.failed > 0 ? `<div class="text-xs text-red-700 mt-1">${r.failed} Fehler im Log.</div>` : ''}
      </div>`;
      toast(`${r.deleted} verwaiste Dokumenttypen gelöscht.`, 'success');
      runDocTypeStats();
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runWipeAllDocTypes() {
    const preserveRaw = $('#wipeDocTypePreserve').value || '';
    const preserveNames = preserveRaw.split(',').map(s => s.trim()).filter(Boolean);
    const deleteDefinitions = $('#wipeDocTypeDeleteDefs').checked;
    if (!confirm(`ACHTUNG: document_type wird auf ALLEN Dokumenten auf null gesetzt${deleteDefinitions ? ' UND die Typ-Definitionen werden gelöscht' : ''}. Fortfahren?`)) return;
    if (!confirm('Letzte Bestätigung — kein Undo-Button. Wirklich?')) return;
    const box = $('#wipeAllDocTypesResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> wipe läuft — kann bei vielen Dokumenten einige Minuten dauern…';
    try {
      const r = await api('/api/optimizer/maintenance/wipe-all-document-types', {
        method: 'POST',
        body: JSON.stringify({ deleteDefinitions, preserveNames }),
      });
      box.innerHTML = `<div class="p-3 rounded bg-white border border-red-300">
        <div class="font-semibold mb-1">Wipe abgeschlossen.</div>
        <ul class="text-xs list-disc list-inside">
          <li>Bearbeitete Typen: <strong>${r.typesProcessed}</strong></li>
          <li>Betroffene Dokumente: <strong>${r.documentsAffected}</strong></li>
          <li>Typ-Definitionen gelöscht: <strong>${r.definitionsDeleted}</strong></li>
          <li>Geschützt: ${r.typesPreserved.map(t => `<code>${escapeHtml(t.name)}</code>`).join(', ') || '(keine)'}</li>
          <li>Backup-Einträge im Log: <strong>${r.backupSize || 0}</strong></li>
        </ul>
      </div>`;
      toast('Dokumenttyp-Wipe abgeschlossen.', 'success');
      runDocTypeStats();
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runCreateTaxViews() {
    const year = parseInt($('#taxViewYear').value, 10);
    if (!year || year < 2000 || year > 2099) { toast('Ungültiges Jahr.', 'warn'); return; }
    const showOnDashboard = $('#taxViewDashboard').checked;
    const box = $('#createTaxViewsResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> lege an…';
    try {
      const r = await api('/api/optimizer/maintenance/create-tax-views', {
        method: 'POST',
        body: JSON.stringify({ year, showOnDashboard }),
      });
      let html = `<div class="p-3 rounded bg-white border border-green-300">`;
      html += `<div class="mb-2"><strong>${r.created.length}</strong> View(s) angelegt für Jahr <strong>${r.year}</strong>.</div>`;
      if (r.created.length) {
        html += '<ul class="text-xs list-disc list-inside mb-2">';
        r.created.forEach(c => html += `<li>${escapeHtml(c.viewName)}</li>`);
        html += '</ul>';
      }
      if (r.skipped.length) {
        html += `<details class="text-xs mt-1"><summary class="cursor-pointer text-text-secondary">${r.skipped.length} übersprungen</summary><ul class="list-disc list-inside mt-1">`;
        r.skipped.forEach(s => html += `<li>${escapeHtml(s.category)}: ${escapeHtml(s.reason)}</li>`);
        html += '</ul></details>';
      }
      if (r.errors.length) {
        html += `<details class="text-xs mt-1 text-red-700"><summary class="cursor-pointer">${r.errors.length} Fehler</summary><ul class="list-disc list-inside mt-1">`;
        r.errors.forEach(e => html += `<li>${escapeHtml(e.category)}: ${escapeHtml(e.error)}</li>`);
        html += '</ul></details>';
      }
      html += '</div>';
      box.innerHTML = html;
      if (r.created.length) toast('Saved Views angelegt.', 'success');
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  async function runSyncNow() {
    const box = $('#syncRunResult');
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sync läuft im Hintergrund — das Badge oben links aktualisiert sich in 30–90 Sekunden.';
    try {
      await api('/api/optimizer/sync-run', { method: 'POST' });
      toast('Sync-Check gestartet.', 'info');
    } catch (e) {
      box.innerHTML = `<div class="p-2 rounded bg-red-100 text-red-800">${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- Utilities ----------

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Wire up ----------

  $('#runAnalysis').addEventListener('click', runAnalysis);
  $('#loadCached').addEventListener('click', loadCached);
  $('#refreshHistory').addEventListener('click', loadHistory);
  $('#refreshIgnores').addEventListener('click', loadIgnores);
  const maintBtn = $('#refreshMaintenance'); if (maintBtn) maintBtn.addEventListener('click', loadMaintenanceStatus);
  const pruneBtn = $('#pruneOrphansBtn'); if (pruneBtn) pruneBtn.addEventListener('click', runPruneOrphans);
  const resetBtn = $('#resetTrackingBtn'); if (resetBtn) resetBtn.addEventListener('click', runResetTracking);
  const syncBtn = $('#syncRunBtn'); if (syncBtn) syncBtn.addEventListener('click', runSyncNow);
  const createViewsBtn = $('#createTaxViewsBtn'); if (createViewsBtn) createViewsBtn.addEventListener('click', runCreateTaxViews);
  const tagStatsBtn = $('#tagStatsBtn'); if (tagStatsBtn) tagStatsBtn.addEventListener('click', runTagStats);
  const delOrphansBtn = $('#deleteOrphanTagsBtn'); if (delOrphansBtn) delOrphansBtn.addEventListener('click', runDeleteOrphans);
  const wipeBtn = $('#wipeAllTagsBtn'); if (wipeBtn) wipeBtn.addEventListener('click', runWipeAllTags);
  const docTypeStatsBtn = $('#docTypeStatsBtn'); if (docTypeStatsBtn) docTypeStatsBtn.addEventListener('click', runDocTypeStats);
  const delOrphanDocTypesBtn = $('#deleteOrphanDocTypesBtn'); if (delOrphanDocTypesBtn) delOrphanDocTypesBtn.addEventListener('click', runDeleteOrphanDocTypes);
  const wipeDocTypesBtn = $('#wipeAllDocTypesBtn'); if (wipeDocTypesBtn) wipeDocTypesBtn.addEventListener('click', runWipeAllDocTypes);

  // Setze Default-Jahr für Saved-Views auf das Vorjahr (typisch: Steuererklärung
  // fürs letzte abgeschlossene Jahr).
  const yearInput = $('#taxViewYear');
  if (yearInput) yearInput.value = new Date().getFullYear() - 1;

  loadProvider();
  // Auto-Load wurde entfernt — der Benutzer triggert das Laden explizit
  // über "Analyse starten" oder "Letztes Ergebnis laden".
})();
