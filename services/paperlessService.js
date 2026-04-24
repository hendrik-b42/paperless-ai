// services/paperlessService.js
const axios = require('axios');
const config = require('../config/config');
const { parse, isValid, parseISO, format } = require('date-fns');

class PaperlessService {
  constructor() {
    this.client = null;
    this.tagCache = new Map();
    this.customFieldCache = new Map();
    this.lastTagRefresh = 0;
    this.CACHE_LIFETIME = 3000; // 3 Sekunden
  }

  initialize() {
    if (!this.client && config.paperless.apiUrl && config.paperless.apiToken) {
      // Fix: Timeout erzwingen. Default axios ist "unendlich", was den Scan bei
      // einem unresponsive Paperless-NGX komplett stoppen lässt (for-Loop hängt
      // beim PATCH). 60s reicht für Große Updates + Re-Index, und triggert im
      // Worst-Case einen Fehler statt eines Deadlocks.
      const timeoutMs = parseInt(process.env.PAPERLESS_HTTP_TIMEOUT_MS || '60000', 10);
      this.client = axios.create({
        baseURL: config.paperless.apiUrl,
        timeout: timeoutMs,
        headers: {
          'Authorization': `Token ${config.paperless.apiToken}`,
          'Content-Type': 'application/json'
        }
      });
      console.log(`[DEBUG] Paperless HTTP client initialized (timeout: ${timeoutMs}ms)`);
    }
  }

  async getThumbnailImage(documentId) {
    this.initialize();
    try { 
      const response = await this.client.get(`/documents/${documentId}/thumb/`, {
        responseType: 'arraybuffer'
      });

      if (response.data && response.data.byteLength > 0) {      
        return Buffer.from(response.data);
      }
      
      console.warn(`[DEBUG] No thumbnail data for document ${documentId}`);
      return null;
    } catch (error) {
      console.error(`[ERROR] fetching thumbnail for document ${documentId}:`, error.message);
      if (error.response) {
        console.log('[ERROR] status:', error.response.status);
        console.log('[ERROR] headers:', error.response.headers);
      }
      return null; // Behalten Sie das return null bei, damit der Prozess weiterlaufen kann
    }
  }


  // Aktualisiert den Tag-Cache, wenn er älter als CACHE_LIFETIME ist

  // Lädt alle existierenden Tags
  async initializeWithCredentials(apiUrl, apiToken) {
    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        'Authorization': `Token ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Test the connection
    try {
      await this.client.get('/');
      return true;
    } catch (error) {
      console.error('[ERROR] Failed to initialize with credentials:', error.message);
      this.client = null;
      return false;
    }
  }


  







  async getDocumentCount() {
    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: { count: true }
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching document count:', error.message);
      return 0;
    }
  }



  
  async getAllDocuments() {
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let documents = [];
    let page = 1;
    let hasMore = true;
    const shouldFilterByTags = process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    let tagIds = [];

    // Vorverarbeitung der Tags, wenn Filter aktiv ist
    if (shouldFilterByTags) {
      if (!process.env.TAGS) {
        console.warn('[DEBUG] PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined');
        return [];
      }
      
      // Hole die Tag-IDs für die definierten Tags
      const tagNames = process.env.TAGS.split(',').map(tag => tag.trim());
      await this.ensureTagCache();
      
      for (const tagName of tagNames) {
        const tag = await this.findExistingTag(tagName);
        if (tag) {
          tagIds.push(tag.id);
        }
      }
      
      if (tagIds.length === 0) {
        console.warn('[DEBUG] None of the specified tags were found');
        return [];
      }
      
      console.log('[DEBUG] Filtering documents for tag IDs:', tagIds);
    }

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,
          fields: 'id,title,created,created_date,added,tags,correspondent'
        };

        // Füge Tag-Filter hinzu, wenn Tags definiert sind
        if (shouldFilterByTags && tagIds.length > 0) {
          // Füge jeden Tag-ID als separaten Parameter hinzu
          tagIds.forEach(id => {
            // Verwende tags__id__in für multiple Tag-Filterung
            params.tags__id__in = tagIds.join(',');
          });
        }

        const response = await this.client.get('/documents/', { params });
        
        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[DEBUG] Invalid API response on page ${page}`);
          break;
        }

        documents = documents.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page-1}, got ${response.data.results.length} documents. ` +
          `[DEBUG] Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`[ERROR]  fetching documents page ${page}:`, error.message);
        if (error.response) {
          console.error('[ERROR] Response status:', error.response.status);
        }
        break;
      }
    }

    console.log(`[DEBUG] Finished fetching. Found ${documents.length} documents.`);
    return documents;
  }

  async getAllDocumentIdsScan() {
    /**
     * Get all Document IDs from the Paperless API.
     * 
     * @returns    An array of all Document IDs.
     * @throws     An error if the request fails.
     * @note       This method is used to get all Document IDs for further processing.
     */
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let documents = [];
    let page = 1;
    let hasMore = true;
    const shouldFilterByTags = process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    let tagIds = [];

    // Vorverarbeitung der Tags, wenn Filter aktiv ist
    if (shouldFilterByTags) {
      if (!process.env.TAGS) {
        console.warn('[DEBUG] PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined');
        return [];
      }
      
      // Hole die Tag-IDs für die definierten Tags
      const tagNames = process.env.TAGS.split(',').map(tag => tag.trim());
      await this.ensureTagCache();
      
      for (const tagName of tagNames) {
        const tag = await this.findExistingTag(tagName);
        if (tag) {
          tagIds.push(tag.id);
        }
      }
      
      if (tagIds.length === 0) {
        console.warn('[DEBUG] None of the specified tags were found');
        return [];
      }
      
      console.log('[DEBUG] Filtering documents for tag IDs:', tagIds);
    }

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,
          fields: 'id'
        };

        const response = await this.client.get('/documents/', { params });
        
        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[ERROR] Invalid API response on page ${page}`);
          break;
        }

        documents = documents.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page-1}, got ${response.data.results.length} documents. ` +
          `[DEBUG] Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`[ERROR] fetching documents page ${page}:`, error.message);
        if (error.response) {
          console.error('[DEBUG] Response status:', error.response.status);
        }
        break;
      }
    }

    console.log(`[DEBUG] Finished fetching. Found ${documents.length} documents.`);
    return documents;
  }

  
  async getDocumentsWithTitleTagsCorrespondentCreated () {
    /**
     * Get all documents with metadata (title, tags, correspondent, created date).
     * 
     * @returns    An array of documents with metadata.
     * @throws     An error if the request fails.
     * @note       This method is used to get all documents with metadata for further processing 
     */
    
    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: {
          fields: 'id,title,tags,correspondent,created'
        }
      });
      return response.data.results;
    } catch (error) {
      console.error('[ERROR] fetching documents with metadata:', error.message);
      return [];
    }
  }

  async getDocumentsForRAGService () {
    /**
     * Get all documents with metadata (title, tags, correspondent, created date and content).
     * 
     * @returns    An array of documents with metadata.
     * @throws     An error if the request fails.
     * @note       This method is used to get all documents with metadata for further processing 
     */
    
    this.initialize();
    try {
      let response;
      let page = 1;
      let hasMore = true;
  
      while (hasMore) {
        try {
          const params = {
            params: { fields: 'id,title,tags,correspondent,created,content' },
            page,
            page_size: 100,  // Maximale Seitengröße für effizientes Laden
            ordering: 'name'  // Optional: Sortierung nach Namen
          };

          response = await this.client.get('/documents/', { params });

          if (!response?.data?.results || !Array.isArray(response.data.results)) {
            console.error(`[DEBUG] Invalid API response on page ${page}`);
            break;
          }

          hasMore = response.data.next !== null;
          page++;
        
        } catch (error) {
          console.error(`[ERROR] fetching documents page ${page}:`, error.message);
          if (error.response) {
            console.error('[ERROR] Response status:', error.response.status);
          }
          break;
        }
      }  
      return response.data.results;
    } catch (error) {
      console.error('[ERROR] fetching documents with metadata:', error.message);
      return [];
    }
  }


  // Aktualisierte getDocuments Methode
  async getDocuments() {
    return this.getAllDocuments();
  }

  async getDocumentContent(documentId) {
    this.initialize();
    const response = await this.client.get(`/documents/${documentId}/`);
    return response.data.content;
  }

  async getDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data;
    } catch (error) {
      console.error(`[ERROR] fetching document ${documentId}:`, error.message);
      throw error;
    }
  }







  async getOwnUserID() {
    this.initialize();
    try {
        const response = await this.client.get('/users/', {
            params: {
                current_user: true,
                full_perms: true
            }
        });

        const userInfo = response.data?.results || [];
        if (userInfo.length === 0) {
            console.warn('[WARN] /users/?current_user=true returned no results. Check PAPERLESS_API_TOKEN permissions.');
            return null;
        }

        // Fix #925: if PAPERLESS_USERNAME is set, try to match it (respects
        // users who run Paperless-AI under a dedicated service account).
        // If empty, or if no match is found, fall back to the single result
        // returned by current_user=true — that IS the token's user.
        const configuredUsername = process.env.PAPERLESS_USERNAME;
        if (configuredUsername) {
            const matched = userInfo.find(u => u.username === configuredUsername);
            if (matched) {
                console.log(`[DEBUG] Found own user ID: ${matched.id} (matched PAPERLESS_USERNAME="${configuredUsername}")`);
                return matched.id;
            }
            console.warn(`[WARN] PAPERLESS_USERNAME="${configuredUsername}" did not match any returned user. Falling back to current_user result.`);
        }

        // Fallback: first user in current_user=true response
        const fallbackUser = userInfo[0];
        console.log(`[DEBUG] Found own user ID: ${fallbackUser.id} (fallback to current_user, username="${fallbackUser.username}")`);
        return fallbackUser.id;
    } catch (error) {
        console.error('[ERROR] fetching own user ID:', error.message);
        return null;
    }
  }
  //Remove if not needed?
  async getOwnerOfDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data.owner;
    } catch (error) {
      console.error(`[ERROR] fetching owner of document ${documentId}:`, error.message);
      return null;
    }
  }

  // Checks if the document is accessable by the current user
  async getPermissionOfDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data.user_can_change;
    } catch (error) {
      console.error(`[ERROR] No Permission to edit document ${documentId}:`, error.message);
      return null;
    }
  }


  async updateDocument(documentId, updates) {
    this.initialize();
    if (!this.client) return;
    try {
      const currentDoc = await this.getDocument(documentId);
      
      if (updates.tags) {
        console.log(`[DEBUG] Current tags for document ${documentId}:`, currentDoc.tags);
        console.log(`[DEBUG] Adding new tags:`, updates.tags);
        console.log(`[DEBUG] Current correspondent:`, currentDoc.correspondent);
        console.log(`[DEBUG] New correspondent:`, updates.correspondent);
                
        const combinedTags = [...new Set([...currentDoc.tags, ...updates.tags])];
        updates.tags = combinedTags;
        
        console.log(`[DEBUG] Combined tags:`, combinedTags);
      }

      if (currentDoc.correspondent && updates.correspondent) {
        console.log('[DEBUG] Document already has a correspondent, keeping existing one:', currentDoc.correspondent);
        delete updates.correspondent;
      }

      let updateData;
      try {
        if (updates.created) {
          let dateObject;
          
          dateObject = parseISO(updates.created);
          
          if (!isValid(dateObject)) {
            dateObject = parse(updates.created, 'dd.MM.yyyy', new Date());
            if (!isValid(dateObject)) {
              dateObject = parse(updates.created, 'dd-MM-yyyy', new Date());
            }
          }
          
          if (!isValid(dateObject)) {
            console.warn(`[WARN] Invalid date format: ${updates.created}, using fallback date: 01.01.1990`);
            dateObject = new Date(1990, 0, 1);
          }
      
          updateData = {
            ...updates,
            created: format(dateObject, 'yyyy-MM-dd'),
          };
        } else {
          updateData = { ...updates };
        }
      } catch (error) {
        console.warn('[WARN] Error parsing date:', error.message);
        console.warn('[DEBUG] Received Date:', updates);
        updateData = {
          ...updates,
          created: format(new Date(1990, 0, 1), 'yyyy-MM-dd'),
        };
      }

      // // Handle custom fields update
      // if (updateData.custom_fields) {
      //   console.log('[DEBUG] Custom fields update detected');
      //   try {
      //     // First, delete existing custom fields
      //     console.log(`[DEBUG] Deleting existing custom fields for document ${documentId}`);
      //     await this.client.delete(`/documents/${documentId}/custom_fields/`);
      //   } catch (error) {
      //     // If deletion fails, try updating with empty array first
      //     console.warn('[WARN] Could not delete custom fields, trying to clear them:', error.message);
      //     await this.client.patch(`/documents/${documentId}/`, { custom_fields: [] });
      //   }
      // }
      
      // Validate title length before sending to API
      if (updateData.title && updateData.title.length > 128) {
        updateData.title = updateData.title.substring(0, 124) + '…';
        console.warn(`[WARN] Title truncated to 128 characters for document ${documentId}`);
      }
      
      console.log('[DEBUG] Final update data:', updateData);
      const patchStart = Date.now();
      console.log(`[DEBUG] PATCH /documents/${documentId}/ start ...`);
      try {
        await this.client.patch(`/documents/${documentId}/`, updateData);
      } catch (patchError) {
        const code = patchError.code || 'n/a';
        const status = patchError.response?.status || 'n/a';
        const data = patchError.response?.data ? JSON.stringify(patchError.response.data).slice(0, 500) : '';
        console.error(`[ERROR] PATCH document ${documentId} failed after ${Date.now() - patchStart}ms. code=${code} status=${status} body=${data}`);
        throw patchError;
      }
      console.log(`[SUCCESS] Updated document ${documentId} in ${Date.now() - patchStart}ms`);
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(`[ERROR] updating document ${documentId}:`, error.message);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Entity Optimizer support
  // -------------------------------------------------------------------------

  /**
   * Alle Dokument-IDs liefern, die einem Korrespondenten zugeordnet sind.
   * Nutzt den Paperless-Filter ?correspondent__id=...
   */

  /**
   * Direktes Umhängen eines Dokuments auf einen anderen Korrespondenten.
   * Umgeht die "keep existing correspondent"-Logik in updateDocument — genau das
   * wollen wir beim Merge.
   */

  /**
   * Versucht, /documents/bulk_edit/ zu nutzen (Paperless-NGX >=1.13), fällt auf Einzel-PATCH
   * zurück, wenn der Endpunkt nicht verfügbar ist.
   */

  /**
   * Kanonischen Korrespondenten-Namen ändern (z.B. "Amazon.de" -> "Amazon").
   */


  // -------------------------------------------------------------------------
  // Tag Optimizer support (Phase 2)
  // -------------------------------------------------------------------------

  /**
   * Alle Tags inkl. document_count — analog zu listCorrespondentsNames().
   */

  /**
   * Alle Dokument-IDs die einen bestimmten Tag haben.
   */

  /**
   * Bulk-modify: fügt targetTagId hinzu und entfernt sourceTagIds auf
   * jedem Dokument. Nutzt /documents/bulk_edit/ wenn verfügbar,
   * sonst Einzel-PATCH je Dokument.
   */

  /**
   * Single-document Tag-Modify. Lädt den aktuellen Tag-Array, berechnet
   * das Delta und PATCHt.
   */



  /**
   * Liefert alle Dokument-IDs aus Paperless-NGX (paginiert). Für Orphan-Cleanup.
   */
  async getAllDocumentIds() {
    this.initialize();
    const ids = [];
    let page = 1;
    try {
      while (true) {
        const resp = await this.client.get('/documents/', {
          params: { page, page_size: 100, fields: 'id' },
        });
        (resp.data?.results || []).forEach(d => ids.push(d.id));
        if (!resp.data?.next) break;
        page++;
        if (page > 500) break;
      }
      return ids;
    } catch (error) {
      console.error('[ERROR] getAllDocumentIds:', error.message);
      return ids;
    }
  }

  // -------------------------------------------------------------------------
  // Document-Type Optimizer support
  // -------------------------------------------------------------------------









}

// Domain-specific methods have been extracted into sibling mixin modules. They
// are mixed into the prototype here so `this.client`, `this.tagCache` etc.
// stay shared across the whole service. No call-site changes required.
Object.assign(
  PaperlessService.prototype,
  require('./paperless/tags'),
  require('./paperless/correspondents'),
  require('./paperless/documentTypes'),
  require('./paperless/customFields'),
  require('./paperless/savedViews'),
);

module.exports = new PaperlessService();
