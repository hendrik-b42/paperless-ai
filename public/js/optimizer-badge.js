// public/js/optimizer-badge.js
//
// Rendert ein kleines Badge neben dem Optimizer-Sidebar-Link, das die Anzahl
// offener Vorschläge anzeigt. Wird in alle Sidebar-Views eingebunden.

(async () => {
  try {
    const link = document.querySelector('a[href="/optimizer"]');
    if (!link) return;
    const span = link.querySelector('span');
    if (!span) return;

    const res = await fetch('/api/optimizer/sync-status', { credentials: 'include' });
    if (!res.ok) return;
    const counts = await res.json();
    if (!counts || !counts.total || counts.total <= 0) return;

    const badge = document.createElement('span');
    badge.textContent = counts.total > 99 ? '99+' : String(counts.total);
    badge.title = `${counts.correspondent} Korrespondenten · ${counts.tag} Tags · ${counts.document_type || 0} Dokumenttypen offen`;
    badge.style.cssText = 'margin-left:auto;background:#2563eb;color:#fff;font-size:10px;padding:2px 6px;border-radius:10px;font-weight:600;';
    link.appendChild(badge);
  } catch (e) {
    // silent fail - not critical
  }
})();
