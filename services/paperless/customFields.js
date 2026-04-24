// services/paperless/customFields.js
//
// Mixin methods for PaperlessService. Mixed into the class via
// Object.assign(PaperlessService.prototype, require('./paperless/customFields')).
// All methods run in the context of the PaperlessService instance, so
// `this.client`, `this.tagCache` etc. refer to the singleton's state.

module.exports = {
  async createCustomFieldSafely(fieldName, fieldType, default_currency) {
    try {
      // Try to create the field first
      const response = await this.client.post('/custom_fields/', { 
        name: fieldName,
        data_type: fieldType,
        extra_data: {
          default_currency: default_currency || null
        }
      });
      const newField = response.data;
      console.log(`[DEBUG] Successfully created custom field "${fieldName}" with ID ${newField.id}`);
      this.customFieldCache.set(fieldName.toLowerCase(), newField);
      return newField;
    } catch (error) { 
      if (error.response?.status === 400) {
        await this.refreshCustomFieldCache();
        const existingField = await this.findExistingCustomField(fieldName);
        if (existingField) {
          return existingField;
        }
      }
      throw error; // When couldn't find the field, rethrow the error
    }
  },

  async getExistingCustomFields(documentId) {
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      console.log('[DEBUG] Document response custom fields:', response.data.custom_fields);
      return response.data.custom_fields || [];
    } catch (error) {
      console.error(`[ERROR] fetching document ${documentId}:`, error.message);
      return [];
    }
  },

  async findExistingCustomField(fieldName) {
    const normalizedName = fieldName.toLowerCase();
    
    const cachedField = this.customFieldCache.get(normalizedName);
    if (cachedField) {
      console.log(`[DEBUG] Found custom field "${fieldName}" in cache with ID ${cachedField.id}`);
      return cachedField;
    }

    try {
      const response = await this.client.get('/custom_fields/', {
        params: {
          name__iexact: normalizedName  // Case-insensitive exact match
        }
      });

      if (response.data.results.length > 0) {
        const foundField = response.data.results[0];
        console.log(`[DEBUG] Found existing custom field "${fieldName}" via API with ID ${foundField.id}`);
        this.customFieldCache.set(normalizedName, foundField);
        return foundField;
      }
    } catch (error) {
      console.warn(`[ERROR] searching for custom field "${fieldName}":`, error.message);
    }

    return null;
  },

  async refreshCustomFieldCache() {
      try {
        console.log('[DEBUG] Refreshing custom field cache...');
        this.customFieldCache.clear();
        let nextUrl = '/custom_fields/';
        while (nextUrl) {
          const response = await this.client.get(nextUrl);

          // Validate response structure
          if (!response?.data?.results) {
            console.error('[ERROR] Invalid response structure from API:', response?.data);
            break;
          }

          response.data.results.forEach(field => {
            this.customFieldCache.set(field.name.toLowerCase(), field);
          });

          // Fix: Extract only path and query from next URL to prevent HTTP downgrade
          if (response.data.next) {
            try {
              const nextUrlObj = new URL(response.data.next);
              const baseUrlObj = new URL(this.client.defaults.baseURL);

              // Extract path relative to baseURL to avoid double /api/ prefix
              let relativePath = nextUrlObj.pathname;
              if (baseUrlObj.pathname && baseUrlObj.pathname !== '/') {
                // Remove the base path if it's included in the next URL path
                relativePath = relativePath.replace(baseUrlObj.pathname, '');
              }
              // Ensure path starts with /
              if (!relativePath.startsWith('/')) {
                relativePath = '/' + relativePath;
              }

              nextUrl = relativePath + nextUrlObj.search;
              console.log('[DEBUG] Next page URL:', nextUrl);
            } catch (e) {
              console.error('[ERROR] Failed to parse next URL:', e.message);
              nextUrl = null;
            }
          } else {
            nextUrl = null;
          }
        }
        this.lastCustomFieldRefresh = Date.now();
        console.log(`[DEBUG] Custom field cache refreshed. Found ${this.customFieldCache.size} fields.`);
      } catch (error) {
        console.error('[ERROR] refreshing custom field cache:', error.message);
        throw error;
      }
    }

,

};
