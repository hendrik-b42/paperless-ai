// services/paperless/bulkOps.js
//
// Wraps Paperless-NGX `/documents/bulk_edit/` with a per-document PATCH fallback.
// Replaces the three hand-rolled copies in paperlessService.js
// (bulkModifyTags, bulkSetCorrespondent, bulkSetDocumentType).

/**
 * Try `/documents/bulk_edit/` first; on any failure, call `perDocFallback(id)`
 * for every document and aggregate the result.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {number[]} documentIds
 * @param {string} method                 bulk_edit method, e.g. 'set_correspondent'
 * @param {object} parameters             body parameters, e.g. { correspondent: 42 }
 * @param {(id: number) => Promise<boolean>} perDocFallback
 *        Invoked once per document on bulk failure. Should return true on success.
 * @param {object} [options]
 * @param {string} [options.label]        Label for log messages.
 * @returns {Promise<{ok: boolean, mode: 'noop'|'bulk'|'fallback', okCount?: number, failCount?: number}>}
 */
async function bulkEditWithFallback(
  client,
  documentIds,
  method,
  parameters,
  perDocFallback,
  options = {}
) {
  const { label = method } = options;

  if (!documentIds.length) {
    return { ok: true, mode: 'noop' };
  }

  try {
    await client.post('/documents/bulk_edit/', {
      documents: documentIds,
      method,
      parameters,
    });
    return { ok: true, mode: 'bulk' };
  } catch (error) {
    console.warn(`[WARN] bulk_edit ${label} failed, fallback to per-doc PATCH:`, error.message);
    let okCount = 0;
    let failCount = 0;
    for (const id of documentIds) {
      const success = await perDocFallback(id);
      success ? okCount++ : failCount++;
    }
    return { ok: failCount === 0, mode: 'fallback', okCount, failCount };
  }
}

module.exports = {
  bulkEditWithFallback,
};
