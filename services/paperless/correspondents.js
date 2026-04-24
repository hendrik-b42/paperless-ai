// services/paperless/correspondents.js
//
// Mixin methods for PaperlessService. Mixed into the class via
// Object.assign(PaperlessService.prototype, require('./paperless/correspondents')).
// All methods run in the context of the PaperlessService instance, so
// `this.client`, `this.tagCache` etc. refer to the singleton's state.

module.exports = {
  async getCorrespondentCount() {
    this.initialize();
    try {
      const response = await this.client.get('/correspondents/', {
        params: { count: true }
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching correspondent count:', error.message);
      return 0;
    }
  },

  async listCorrespondentsNames() {
    this.initialize();
    let allCorrespondents = [];
    let page = 1;
    let hasNextPage = true;
  
    try {
      while (hasNextPage) {
        const response = await this.client.get('/correspondents/', {
          params: {
            fields: 'id,name',
            count: true,
            page: page
          }
        });
  
        const { results, next } = response.data;
        
        // Füge die Ergebnisse der aktuellen Seite hinzu
        allCorrespondents = allCorrespondents.concat(
          results.map(correspondent => ({
            name: correspondent.name,
            id: correspondent.id,
            document_count: correspondent.document_count
          }))
        );
  
        // Prüfe, ob es eine nächste Seite gibt
        hasNextPage = next !== null;
        page++;
  
        // Optional: Füge eine kleine Verzögerung hinzu, um die API nicht zu überlasten
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
  
      return allCorrespondents;
  
    } catch (error) {
      console.error('[ERROR] fetching correspondent names:', error.message);
      return [];
    }
  },

  async getCorrespondentNameById(correspondentId) {
    /**
     * Get the Name of a Correspondent by its ID.
     * 
     * @param   id  The id of the correspondent.
     * @returns    The name of the correspondent.
     */
    this.initialize();
    try {
      const response = await this.client.get(`/correspondents/${correspondentId}/`);
      return response.data;
    } catch (error) {
      console.error(`[ERROR] fetching correspondent ${correspondentId}:`, error.message);
      return null;
    }
  },

  async searchForCorrespondentById(id) {
    try {
      const response = await this.client.get('/correspondents/', {
          params: {
              id: id
          }
      });

      const results = response.data.results;
      
      if (results.length === 0) {
          console.log(`[DEBUG] No correspondent with "${id}" found`);
          return null;
      }
      
      if (results.length > 1) {
          console.log(`[DEBUG] Multiple correspondents found:`);
          results.forEach(c => {
              console.log(`- ID: ${c.id}, Name: ${c.name}`);
          });
          return results;
      }

      // Genau ein Ergebnis gefunden
      return {
          id: results[0].id,
          name: results[0].name
      };

  } catch (error) {
      console.error('[ERROR] while seraching for existing correspondent:', error.message);
      throw error;
  }
  },

  async searchForExistingCorrespondent(correspondent) {
    try {
        const response = await this.client.get('/correspondents/', {
            params: {
                name__icontains: correspondent
            }
        });
  
        const results = response.data.results;
        
        if (results.length === 0) {
            console.log(`[DEBUG] No correspondent with name "${correspondent}" found`);
            return null;
        }
        
        // Check for exact match in the results - thanks to @skius for the hint!
        const exactMatch = results.find(c => c.name.toLowerCase() === correspondent.toLowerCase());
        if (exactMatch) {
            console.log(`[DEBUG] Found exact match for correspondent "${correspondent}" with ID ${exactMatch.id}`);
            return {
                id: exactMatch.id,
                name: exactMatch.name
            };
        }
  
        // No exact match found, return null
        console.log(`[DEBUG] No exact match found for "${correspondent}"`);
        return null;
  
    } catch (error) {
        console.error('[ERROR] while searching for existing correspondent:', error.message);
        throw error;
    }
  },

  async getOrCreateCorrespondent(name, options = {}) {
    this.initialize();
    
    // Check if we should restrict to existing correspondents
    // Explicitly check options first, then env var
    const restrictToExistingCorrespondents = options.restrictToExistingCorrespondents === true || 
                                           (options.restrictToExistingCorrespondents === undefined && 
                                            process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS === 'yes');
    
    console.log(`[DEBUG] Processing correspondent with restrictToExistingCorrespondents=${restrictToExistingCorrespondents}`);
  
    try {
        // Search for the correspondent
        const existingCorrespondent = await this.searchForExistingCorrespondent(name);
        console.log("[DEBUG] Response Correspondent Search: ", existingCorrespondent);
    
        if (existingCorrespondent) {
            console.log(`[DEBUG] Found existing correspondent "${name}" with ID ${existingCorrespondent.id}`);
            return existingCorrespondent;
        }
        
        // If we're restricting to existing correspondents and none was found, return null
        if (restrictToExistingCorrespondents) {
            console.log(`[DEBUG] Correspondent "${name}" does not exist and restrictions are enabled, returning null`);
            return null;
        }
    
        // Create new correspondent only if restrictions are not enabled
        try {
            const createResponse = await this.client.post('/correspondents/', { 
                name: name 
            });
            console.log(`[DEBUG] Created new correspondent "${name}" with ID ${createResponse.data.id}`);
            return createResponse.data;
        } catch (createError) {
            if (createError.response?.status === 400 && 
                createError.response?.data?.error?.includes('unique constraint')) {
              
                // Race condition check - another process might have created it
                const retryResponse = await this.client.get('/correspondents/', {
                    params: { name: name }
                });
              
                const justCreatedCorrespondent = retryResponse.data.results.find(
                    c => c.name.toLowerCase() === name.toLowerCase()
                );
              
                if (justCreatedCorrespondent) {
                    console.log(`[DEBUG] Retrieved correspondent "${name}" after constraint error with ID ${justCreatedCorrespondent.id}`);
                    return justCreatedCorrespondent;
                }
            }
            throw createError;
        }
    } catch (error) {
        console.error(`[ERROR] Failed to process correspondent "${name}":`, error.message);
        throw error;
    }
  },

  async getDocumentIdsByCorrespondent(correspondentId) {
    this.initialize();
    const ids = [];
    let page = 1;
    try {
      while (true) {
        const response = await this.client.get('/documents/', {
          params: {
            correspondent__id: correspondentId,
            page,
            page_size: 100,
            fields: 'id,title',
          },
        });
        const results = response.data?.results || [];
        results.forEach(d => ids.push({ id: d.id, title: d.title }));
        if (!response.data?.next) break;
        page++;
        if (page > 200) break; // safety
      }
      return ids;
    } catch (error) {
      console.error(`[ERROR] fetching documents for correspondent ${correspondentId}:`, error.message);
      return [];
    }
  },

  async setDocumentCorrespondent(documentId, correspondentId) {
    this.initialize();
    if (!this.client) return false;
    try {
      await this.client.patch(`/documents/${documentId}/`, { correspondent: correspondentId });
      return true;
    } catch (error) {
      console.error(`[ERROR] setDocumentCorrespondent doc=${documentId} corr=${correspondentId}:`, error.message);
      return false;
    }
  },

  async bulkSetCorrespondent(documentIds, correspondentId) {
    this.initialize();
    if (!documentIds.length) return { ok: true, mode: 'noop' };
    try {
      await this.client.post('/documents/bulk_edit/', {
        documents: documentIds,
        method: 'set_correspondent',
        parameters: { correspondent: correspondentId },
      });
      return { ok: true, mode: 'bulk' };
    } catch (error) {
      console.warn('[WARN] bulk_edit failed, falling back to per-document PATCH:', error.message);
      let ok = 0;
      let fail = 0;
      for (const id of documentIds) {
        const success = await this.setDocumentCorrespondent(id, correspondentId);
        success ? ok++ : fail++;
      }
      return { ok: fail === 0, mode: 'fallback', okCount: ok, failCount: fail };
    }
  },

  async renameCorrespondent(correspondentId, newName) {
    this.initialize();
    if (!this.client) return false;
    try {
      await this.client.patch(`/correspondents/${correspondentId}/`, { name: newName });
      return true;
    } catch (error) {
      console.error(`[ERROR] renameCorrespondent ${correspondentId} -> ${newName}:`, error.message);
      return false;
    }
  },

  async deleteCorrespondent(correspondentId) {
    this.initialize();
    if (!this.client) return false;
    try {
      await this.client.delete(`/correspondents/${correspondentId}/`);
      return true;
    } catch (error) {
      console.error(`[ERROR] deleteCorrespondent ${correspondentId}:`, error.message);
      return false;
    }
  },

};
