// services/paperless/savedViews.js
//
// Mixin methods for PaperlessService. Mixed into the class via
// Object.assign(PaperlessService.prototype, require('./paperless/savedViews')).
// All methods run in the context of the PaperlessService instance, so
// `this.client`, `this.tagCache` etc. refer to the singleton's state.

module.exports = {
  async listSavedViews() {
    this.initialize();
    try {
      const resp = await this.client.get('/saved_views/', { params: { page_size: 100 } });
      return resp.data?.results || [];
    } catch (error) {
      console.error('[ERROR] listSavedViews:', error.message);
      return [];
    }
  },

  async createSavedView(payload) {
    this.initialize();
    try {
      const resp = await this.client.post('/saved_views/', payload);
      return { ok: true, view: resp.data };
    } catch (error) {
      console.error('[ERROR] createSavedView:', error.message, error.response?.data);
      return { ok: false, error: error.message, details: error.response?.data };
    }
  },

  async deleteSavedView(id) {
    this.initialize();
    try {
      await this.client.delete(`/saved_views/${id}/`);
      return true;
    } catch (error) {
      console.error(`[ERROR] deleteSavedView ${id}:`, error.message);
      return false;
    }
  },

};
