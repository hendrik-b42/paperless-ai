// services/paperless/tags.js
//
// Mixin methods for PaperlessService. Mixed into the class via
// Object.assign(PaperlessService.prototype, require('./paperless/tags')).
// All methods run in the context of the PaperlessService instance, so
// `this.client`, `this.tagCache` etc. refer to the singleton's state.

module.exports = {
  async ensureTagCache() {
    const now = Date.now();
    if (this.tagCache.size === 0 || (now - this.lastTagRefresh) > this.CACHE_LIFETIME) {
      await this.refreshTagCache();
    }
  },

  async refreshTagCache() {
      try {
        console.log('[DEBUG] Refreshing tag cache...');
        this.tagCache.clear();
        let nextUrl = '/tags/';
        while (nextUrl) {
          const response = await this.client.get(nextUrl);

          // Validate response structure
          if (!response?.data?.results) {
            console.error('[ERROR] Invalid response structure from API:', response?.data);
            break;
          }

          response.data.results.forEach(tag => {
            this.tagCache.set(tag.name.toLowerCase(), tag);
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
        this.lastTagRefresh = Date.now();
        console.log(`[DEBUG] Tag cache refreshed. Found ${this.tagCache.size} tags.`);
      } catch (error) {
        console.error('[ERROR] refreshing tag cache:', error.message);
        throw error;
      }
    }
,

  async findExistingTag(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    // 1. Zuerst im Cache suchen
    const cachedTag = this.tagCache.get(normalizedName);
    if (cachedTag) {
      console.log(`[DEBUG] Found tag "${tagName}" in cache with ID ${cachedTag.id}`);
      return cachedTag;
    }

    // 2. Direkte API-Suche
    try {
      const response = await this.client.get('/tags/', {
        params: {
          name__iexact: normalizedName  // Case-insensitive exact match
        }
      });

      if (response.data.results.length > 0) {
        const foundTag = response.data.results[0];
        console.log(`[DEBUG] Found existing tag "${tagName}" via API with ID ${foundTag.id}`);
        this.tagCache.set(normalizedName, foundTag);
        return foundTag;
      }
    } catch (error) {
      console.warn(`[ERROR] searching for tag "${tagName}":`, error.message);
    }

    return null;
  },

  async createTagSafely(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    try {
      // Versuche zuerst, den Tag zu erstellen
      const response = await this.client.post('/tags/', { name: tagName });
      const newTag = response.data;
      console.log(`[DEBUG] Successfully created tag "${tagName}" with ID ${newTag.id}`);
      this.tagCache.set(normalizedName, newTag);
      return newTag;
    } catch (error) {
      if (error.response?.status === 400) {
        // Bei einem 400er Fehler könnte der Tag bereits existieren
        // Aktualisiere den Cache und suche erneut
        await this.refreshTagCache();
        
        // Suche nochmal nach dem Tag
        const existingTag = await this.findExistingTag(tagName);
        if (existingTag) {
          return existingTag;
        }
      }
      throw error; // Wenn wir den Tag nicht finden konnten, werfen wir den Fehler weiter
    }
  },

  async processTags(tagNames, options = {}) {
    try {
      this.initialize();
      await this.ensureTagCache();
      
      // Check if we should restrict to existing tags
      // Explicitly check options first, then env var
      const restrictToExistingTags = options.restrictToExistingTags === true || 
                                   (options.restrictToExistingTags === undefined && 
                                    process.env.RESTRICT_TO_EXISTING_TAGS === 'yes');
      
      // Input validation
      if (!tagNames) {
        console.warn('[DEBUG] No tags provided to processTags');
        return { tagIds: [], errors: [] };
      }

      // Convert to array if string is passed
      const tagsArray = typeof tagNames === 'string' 
        ? [tagNames]
        : Array.isArray(tagNames) 
          ? tagNames 
          : [];

      if (tagsArray.length === 0) {
        console.warn('[DEBUG] No valid tags to process');
        return { tagIds: [], errors: [] };
      }
  
      const tagIds = [];
      const errors = [];
      const processedTags = new Set(); // Prevent duplicates
      
      console.log(`[DEBUG] Processing tags with restrictToExistingTags=${restrictToExistingTags}`);
  
      // Process regular tags
      for (const tagName of tagsArray) {
        if (!tagName || typeof tagName !== 'string') {
          console.warn(`[DEBUG] Skipping invalid tag name: ${tagName}`);
          errors.push({ tagName, error: 'Invalid tag name' });
          continue;
        }
  
        const normalizedName = tagName.toLowerCase().trim();
        
        // Skip empty or already processed tags
        if (!normalizedName || processedTags.has(normalizedName)) {
          continue;
        }
  
        try {
          // Search for existing tag first
          let tag = await this.findExistingTag(tagName);
          
          // If no existing tag found and restrictions are not enabled, create new one
          if (!tag && !restrictToExistingTags) {
            tag = await this.createTagSafely(tagName);
          } else if (!tag && restrictToExistingTags) {
            console.log(`[DEBUG] Tag "${tagName}" does not exist and restrictions are enabled, skipping`);
            errors.push({ tagName, error: 'Tag does not exist and restrictions are enabled' });
            continue;
          }
  
          if (tag && tag.id) {
            tagIds.push(tag.id);
            processedTags.add(normalizedName);
          }
  
        } catch (error) {
          console.error(`[ERROR] processing tag "${tagName}":`, error.message);
          errors.push({ tagName, error: error.message });
        }
      }
  
      // Add AI-Processed tag if enabled
      if (process.env.ADD_AI_PROCESSED_TAG === 'yes' && process.env.AI_PROCESSED_TAG_NAME) {
        try {
          const aiTagName = process.env.AI_PROCESSED_TAG_NAME;
          let aiTag = await this.findExistingTag(aiTagName);
          
          if (!aiTag) {
            aiTag = await this.createTagSafely(aiTagName);
          }
  
          if (aiTag && aiTag.id) {
            tagIds.push(aiTag.id);
          }
        } catch (error) {
          console.error(`[ERROR] processing AI tag "${process.env.AI_PROCESSED_TAG_NAME}":`, error.message);
          errors.push({ tagName: process.env.AI_PROCESSED_TAG_NAME, error: error.message });
        }
      }
  
      return { 
        tagIds: [...new Set(tagIds)], // Remove any duplicates
        errors 
      };      
    } catch (error) {
      console.error('[ERROR] in processTags:', error);
      throw new Error(`[ERROR] Failed to process tags: ${error.message}`);
    }
  },

  async getTags() {
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let tags = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,  // Maximale Seitengröße für effizientes Laden
          ordering: 'name'  // Optional: Sortierung nach Namen
        };

        const response = await this.client.get('/tags/', { params });
        
        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[DEBUG] Invalid API response on page ${page}`);
          break;
        }

        tags = tags.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page-1}, got ${response.data.results.length} tags. ` +
          `[DEBUG] Total so far: ${tags.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`[ERRRO] fetching tags page ${page}:`, error.message);
        if (error.response) {
          console.error('[DEBUG] Response status:', error.response.status);
          console.error('[DEBUG] Response data:', error.response.data);
        }
        break;
      }
    }

    return tags;
  },

  async getTagCount() {
    this.initialize();
    try {
      const response = await this.client.get('/tags/', {
        params: { count: true }
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching tag count:', error.message);
      return 0;
    }
  },

  async listTagNames() {
    this.initialize();
    let allTags = [];
    let currentPage = 1;
    let hasMorePages = true;
  
    try {
      while (hasMorePages) {
        const response = await this.client.get('/tags/', {
          params: {
            fields: 'name',
            count: true,
            page: currentPage,
            page_size: 100 // Sie können die Seitengröße nach Bedarf anpassen
          }
        });
  
        // Füge die Tags dieser Seite zum Gesamtergebnis hinzu
        allTags = allTags.concat(
          response.data.results.map(tag => ({
            name: tag.name,
            document_count: tag.document_count
          }))
        );
  
        // Prüfe, ob es weitere Seiten gibt
        hasMorePages = response.data.next !== null;
        currentPage++;
      }
  
      return allTags;
    } catch (error) {
      console.error('[DEBUG] Error fetching tag names:', error.message);
      return [];
    }
  },

  async removeUnusedTagsFromDocument(documentId, keepTagIds) {
    this.initialize();
    if (!this.client) return;
  
    try {
      console.log(`[DEBUG] Removing unused tags from document ${documentId}, keeping tags:`, keepTagIds);
      
      // Hole aktuelles Dokument
      const currentDoc = await this.getDocument(documentId);
      
      // Finde Tags die entfernt werden sollen (die nicht in keepTagIds sind)
      const tagsToRemove = currentDoc.tags.filter(tagId => !keepTagIds.includes(tagId));
      
      if (tagsToRemove.length === 0) {
        console.log('[DEBUG] No tags to remove');
        return currentDoc;
      }
  
      // Update das Dokument mit nur den zu behaltenden Tags
      const updateData = {
        tags: keepTagIds
      };
  
      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(`[DEBUG] Successfully removed ${tagsToRemove.length} tags from document ${documentId}`);
      
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(`[ERROR] Error removing unused tags from document ${documentId}:`, error.message);
      throw error;
    }
  },

  async getTagTextFromId(tagId) {
    this.initialize();
    try {
      const response = await this.client.get(`/tags/${tagId}/`);
      return response.data.name;
    } catch (error) {
      console.error(`[ERROR] fetching tag text for ID ${tagId}:`, error.message);
      return null;
    }
  },

  async listTagsWithCount() {
    this.initialize();
    const all = await this.getTags();
    return all.map(t => ({ id: t.id, name: t.name, document_count: t.document_count || 0 }));
  },

  async getDocumentIdsByTag(tagId) {
    this.initialize();
    const ids = [];
    let page = 1;
    try {
      while (true) {
        const response = await this.client.get('/documents/', {
          params: {
            tags__id: tagId,
            page,
            page_size: 100,
            fields: 'id,title',
          },
        });
        const results = response.data?.results || [];
        results.forEach(d => ids.push({ id: d.id, title: d.title }));
        if (!response.data?.next) break;
        page++;
        if (page > 200) break;
      }
      return ids;
    } catch (error) {
      console.error(`[ERROR] fetching documents for tag ${tagId}:`, error.message);
      return [];
    }
  },

  async bulkModifyTags(documentIds, addTagIds = [], removeTagIds = []) {
    this.initialize();
    if (!documentIds.length) return { ok: true, mode: 'noop' };
    try {
      await this.client.post('/documents/bulk_edit/', {
        documents: documentIds,
        method: 'modify_tags',
        parameters: { add_tags: addTagIds, remove_tags: removeTagIds },
      });
      return { ok: true, mode: 'bulk' };
    } catch (error) {
      console.warn('[WARN] bulk_edit modify_tags failed, falling back to per-document PATCH:', error.message);
      let ok = 0;
      let fail = 0;
      for (const id of documentIds) {
        const success = await this.modifyDocumentTags(id, addTagIds, removeTagIds);
        success ? ok++ : fail++;
      }
      return { ok: fail === 0, mode: 'fallback', okCount: ok, failCount: fail };
    }
  },

  async modifyDocumentTags(documentId, addTagIds = [], removeTagIds = []) {
    this.initialize();
    if (!this.client) return false;
    try {
      const doc = await this.getDocument(documentId);
      const current = new Set(doc.tags || []);
      removeTagIds.forEach(id => current.delete(id));
      addTagIds.forEach(id => current.add(id));
      await this.client.patch(`/documents/${documentId}/`, { tags: [...current] });
      return true;
    } catch (error) {
      console.error(`[ERROR] modifyDocumentTags doc=${documentId}:`, error.message);
      return false;
    }
  },

  async renameTag(tagId, newName) {
    this.initialize();
    if (!this.client) return false;
    try {
      await this.client.patch(`/tags/${tagId}/`, { name: newName });
      return true;
    } catch (error) {
      console.error(`[ERROR] renameTag ${tagId} -> ${newName}:`, error.message);
      return false;
    }
  },

  async deleteTag(tagId) {
    this.initialize();
    if (!this.client) return false;
    try {
      await this.client.delete(`/tags/${tagId}/`);
      return true;
    } catch (error) {
      console.error(`[ERROR] deleteTag ${tagId}:`, error.message);
      return false;
    }
  },

  async getOrCreateTag(name) {
    this.initialize();
    try {
      // Try to find exact match first
      const response = await this.client.get('/tags/', { params: { name__iexact: name } });
      const exact = response.data?.results?.find(t => t.name.toLowerCase() === name.toLowerCase());
      if (exact) return exact;
      const created = await this.client.post('/tags/', { name });
      return created.data;
    } catch (error) {
      console.error(`[ERROR] getOrCreateTag "${name}":`, error.message);
      return null;
    }
  },

};
