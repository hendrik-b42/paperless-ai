// services/paperless/paginator.js
//
// Generic pagination helper for Paperless-NGX REST endpoints.
//
// Replaces the ~8 copies of hand-rolled while/page++ loops in paperlessService.js.
// Handles the HTTP-downgrade quirk of Paperless: the absolute `next` URL can
// resolve to http:// when Paperless runs behind a TLS-terminating proxy, so we
// strip it back to a path relative to the axios baseURL.

/**
 * Convert the absolute `next` URL from a Paperless paginated response to a
 * path that is safe to pass back to the same axios client without triggering
 * an HTTP downgrade or a double `/api/` prefix.
 *
 * @param {string} nextUrl   The `next` field from a paginated response.
 * @param {string} baseURL   The axios client's baseURL.
 * @returns {string|null}    Relative path + query, or null on parse failure.
 */
function toRelativeNextPath(nextUrl, baseURL) {
  try {
    const nextUrlObj = new URL(nextUrl);
    const baseUrlObj = new URL(baseURL);

    let relativePath = nextUrlObj.pathname;
    if (baseUrlObj.pathname && baseUrlObj.pathname !== '/') {
      relativePath = relativePath.replace(baseUrlObj.pathname, '');
    }
    if (!relativePath.startsWith('/')) {
      relativePath = '/' + relativePath;
    }
    return relativePath + nextUrlObj.search;
  } catch (e) {
    return null;
  }
}

/**
 * Iterate every page of a Paperless endpoint and collect the results.
 *
 * @param {import('axios').AxiosInstance} client
 * @param {string} endpoint                 e.g. '/tags/', '/documents/'
 * @param {object} [options]
 * @param {object} [options.params]         Query params for the first request.
 * @param {number} [options.pageSize=100]
 * @param {number} [options.maxPages=500]   Safety cap.
 * @param {(page: object) => void} [options.onPage]
 *        Optional callback invoked with each raw response body — useful when
 *        the caller wants to stream results instead of buffering them.
 * @returns {Promise<any[]>}  Concatenated `results` across all pages.
 */
async function paginate(client, endpoint, options = {}) {
  const {
    params = {},
    pageSize = 100,
    maxPages = 500,
    onPage,
  } = options;

  const collected = [];
  let url = endpoint;
  let firstRequest = true;

  for (let i = 0; i < maxPages; i++) {
    const requestConfig = firstRequest
      ? { params: { ...params, page_size: pageSize } }
      : undefined;
    firstRequest = false;

    const response = await client.get(url, requestConfig);

    if (!response?.data?.results || !Array.isArray(response.data.results)) {
      break;
    }

    if (onPage) {
      onPage(response.data);
    }
    collected.push(...response.data.results);

    if (!response.data.next) break;

    const nextPath = toRelativeNextPath(response.data.next, client.defaults.baseURL);
    if (!nextPath) break;
    url = nextPath;
  }

  return collected;
}

module.exports = {
  paginate,
  toRelativeNextPath,
};
