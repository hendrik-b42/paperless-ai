// services/paperless/documentTypes.js
//
// Mixin methods for PaperlessService. Mixed into the class via
// Object.assign(PaperlessService.prototype, require('./paperless/documentTypes')).
// All methods run in the context of the PaperlessService instance, so
// `this.client`, `this.tagCache` etc. refer to the singleton's state.

module.exports = {
  async listDocumentTypesNames() {
    this.initialize();
    let allDocumentTypes = [];
    let page = 1;
    let hasNextPage = true;
  
    try {
      while (hasNextPage) {
        const response = await this.client.get('/document_types/', {
          params: {
            fields: 'id,name',
            count: true,
            page: page
          }
        });
  
        const { results, next } = response.data;
        
        allDocumentTypes = allDocumentTypes.concat(
          results.map(docType => ({
            name: docType.name,
            id: docType.id
          }))
        );
  
        hasNextPage = next !== null;
        page++;
  
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
  
      return allDocumentTypes;
  
    } catch (error) {
      console.error('[ERROR] fetching document type names:', error.message);
      return [];
    }
  },

  async searchForExistingDocumentType(documentType) {
    try {
        const response = await this.client.get('/document_types/', {
            params: {
                name__icontains: documentType
            }
        });
  
        const results = response.data.results;
        
        if (results.length === 0) {
            console.log(`[DEBUG] No document type with name "${documentType}" found`);
            return null;
        }
        
        // Check for exact match in the results
        const exactMatch = results.find(dt => dt.name.toLowerCase() === documentType.toLowerCase());
        if (exactMatch) {
            console.log(`[DEBUG] Found exact match for document type "${documentType}" with ID ${exactMatch.id}`);
            return {
                id: exactMatch.id,
                name: exactMatch.name
            };
        }
  
        // No exact match found, return null
        console.log(`[DEBUG] No exact match found for "${documentType}"`);
        return null;
  
    } catch (error) {
        console.error('[ERROR] while searching for existing document type:', error.message);
        throw error;
    }
  },

  async listDocumentTypesWithCount() {
    this.initialize();
    let all = [];
    let page = 1;
    try {
      while (true) {
        const resp = await this.client.get('/document_types/', {
          params: { page, page_size: 100 },
        });
        const results = resp.data?.results || [];
        all = all.concat(results.map(dt => ({
          id: dt.id,
          name: dt.name,
          document_count: dt.document_count || 0,
        })));
        if (!resp.data?.next) break;
        page++;
        if (page > 200) break;
      }
      return all;
    } catch (error) {
      console.error('[ERROR] listDocumentTypesWithCount:', error.message);
      return [];
    }
  },

  async getDocumentTypeCount() {
    this.initialize();
    try {
      const resp = await this.client.get('/document_types/', { params: { count: true } });
      return resp.data.count;
    } catch (error) {
      console.error('[ERROR] getDocumentTypeCount:', error.message);
      return 0;
    }
  },

  async getDocumentIdsByDocumentType(documentTypeId) {
    this.initialize();
    const ids = [];
    let page = 1;
    try {
      while (true) {
        const resp = await this.client.get('/documents/', {
          params: {
            document_type__id: documentTypeId,
            page, page_size: 100, fields: 'id,title',
          },
        });
        const results = resp.data?.results || [];
        results.forEach(d => ids.push({ id: d.id, title: d.title }));
        if (!resp.data?.next) break;
        page++;
        if (page > 200) break;
      }
      return ids;
    } catch (error) {
      console.error(`[ERROR] getDocumentIdsByDocumentType ${documentTypeId}:`, error.message);
      return [];
    }
  },

  async setDocumentDocumentType(documentId, documentTypeId) {
    this.initialize();
    if (!this.client) return false;
    try {
      await this.client.patch(`/documents/${documentId}/`, { document_type: documentTypeId });
      return true;
    } catch (error) {
      console.error(`[ERROR] setDocumentDocumentType doc=${documentId}:`, error.message);
      return false;
    }
  },

  async bulkSetDocumentType(documentIds, documentTypeId) {
    this.initialize();
    if (!documentIds.length) return { ok: true, mode: 'noop' };
    try {
      await this.client.post('/documents/bulk_edit/', {
        documents: documentIds,
        method: 'set_document_type',
        parameters: { document_type: documentTypeId },
      });
      return { ok: true, mode: 'bulk' };
    } catch (error) {
      console.warn('[WARN] bulk_edit set_document_type failed, fallback to per-doc PATCH:', error.message);
      let ok = 0, fail = 0;
      for (const id of documentIds) {
        const success = await this.setDocumentDocumentType(id, documentTypeId);
        success ? ok++ : fail++;
      }
      return { ok: fail === 0, mode: 'fallback', okCount: ok, failCount: fail };
    }
  },

  async renameDocumentType(id, newName) {
    this.initialize();
    try {
      await this.client.patch(`/document_types/${id}/`, { name: newName });
      return true;
    } catch (error) {
      console.error(`[ERROR] renameDocumentType ${id}:`, error.message);
      return false;
    }
  },

  async deleteDocumentType(id) {
    this.initialize();
    try {
      await this.client.delete(`/document_types/${id}/`);
      return true;
    } catch (error) {
      console.error(`[ERROR] deleteDocumentType ${id}:`, error.message);
      return false;
    }
  },

  async getOrCreateDocumentType(name) {
    this.initialize();
    try {
      const resp = await this.client.get('/document_types/', { params: { name__iexact: name } });
      const exact = resp.data?.results?.find(dt => dt.name.toLowerCase() === name.toLowerCase());
      if (exact) return exact;
      const created = await this.client.post('/document_types/', { name });
      return created.data;
    } catch (error) {
      console.error(`[ERROR] getOrCreateDocumentType "${name}":`, error.message);
      return null;
    }
  },

  async clearDocumentType(documentId) {
    this.initialize();
    try {
      await this.client.patch(`/documents/${documentId}/`, { document_type: null });
      return true;
    } catch (error) {
      console.error(`[ERROR] clearDocumentType doc=${documentId}:`, error.message);
      return false;
    }
  },

};
