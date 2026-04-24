// services/paperless/findOrCreate.js
//
// Generic "find-by-exact-name or create" helper for Paperless taxonomy
// entities (tags, correspondents, document_types). Handles the race where a
// concurrent request creates the same entity just before our POST and we hit
// a 400 unique-constraint error.
//
// Replaces the three copies embedded in paperlessService.js:
//   - getOrCreateCorrespondent
//   - getOrCreateDocumentType
//   - createTagSafely (tag variant)

/**
 * Case-insensitive exact lookup against a Paperless list endpoint.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} endpoint   e.g. '/correspondents/'
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function searchExact(client, endpoint, name) {
  const response = await client.get(endpoint, {
    params: { name__iexact: name },
  });
  const results = response.data?.results || [];
  return results.find(r => r.name?.toLowerCase() === name.toLowerCase()) || null;
}

/**
 * Look up `name` via exact match; on miss, POST it. If the POST races with
 * another client and returns 400 (unique-constraint), re-query and return
 * the winner.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} endpoint             e.g. '/document_types/'
 * @param {string} name
 * @param {object} [extraPayload]       Extra fields for the POST body.
 * @returns {Promise<object|null>}      The (possibly just-created) entity, or null on hard failure.
 */
async function findOrCreateEntity(client, endpoint, name, extraPayload = {}) {
  try {
    const existing = await searchExact(client, endpoint, name);
    if (existing) return existing;
  } catch (error) {
    console.warn(`[WARN] findOrCreateEntity search ${endpoint} "${name}":`, error.message);
    // Fall through to POST — maybe the search failed transiently.
  }

  try {
    const response = await client.post(endpoint, { name, ...extraPayload });
    return response.data;
  } catch (createError) {
    if (createError.response?.status === 400) {
      // Race: another writer created it between our search and POST.
      try {
        const raced = await searchExact(client, endpoint, name);
        if (raced) return raced;
      } catch (_) { /* ignore — return null below */ }
    }
    console.error(`[ERROR] findOrCreateEntity create ${endpoint} "${name}":`, createError.message);
    return null;
  }
}

module.exports = {
  findOrCreateEntity,
  searchExact,
};
