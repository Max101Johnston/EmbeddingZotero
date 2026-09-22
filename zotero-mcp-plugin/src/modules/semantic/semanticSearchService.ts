/**
 * Semantic Search Service for Zotero MCP Plugin
 *
 * Main service that orchestrates:
 * - Embedding generation (EmbeddingService)
 * - Vector storage and search (VectorStore)
 * - Text processing (TextChunker)
 * - Integration with existing Zotero services
 */

import { getEmbeddingService, EmbeddingService, EmbeddingAPIError, EmbeddingErrorType } from './embeddingService';
import { getVectorStore, VectorStore } from './vectorStore';
import { getTextChunker, TextChunker } from './textChunker';
import { TextFormatter } from '../textFormatter';
import { PDFProcessor } from '../pdfProcessor';
import { getIndexConcurrency } from './indexConcurrency';

declare let Zotero: any;
declare let ztoolkit: ZToolkit;

// Preference key for persisting index progress
const PREF_INDEX_PROGRESS = 'extensions.zotero.zotero-mcp-plugin.semantic.indexProgress';

// ============ Interfaces ============

export interface SemanticSearchOptions {
  topK?: number;              // Number of results
  minScore?: number;          // Minimum similarity threshold
  language?: 'zh' | 'en' | 'all';  // Language filter
  itemKeys?: string[];        // Limit to specific items
}

export interface SemanticSearchResult {
  itemKey: string;
  parentKey?: string;
  title: string;
  creators?: string;
  year?: number;
  itemType?: string;
  score: number;
  matchedChunks: Array<{
    chunkId: number;
    text: string;
    score: number;
  }>;
}

export interface IndexProgress {
  total: number;
  processed: number;
  currentItem?: string;
  status: 'idle' | 'indexing' | 'paused' | 'completed' | 'error' | 'aborted' | 'busy';
  error?: string;
  errorType?: EmbeddingErrorType;  // Type of error for UI display
  errorRetryable?: boolean;        // Whether the error can be retried
  startTime?: number;
  estimatedRemaining?: number;
  failedCount?: number;            // Number of failed items
  mode?: 'normal' | 'repair';
}

export interface SemanticServiceStats {
  indexStats: {
    totalVectors: number;
    totalItems: number;
    zhVectors: number;
    enVectors: number;
    cachedContentItems?: number;
    cachedContentSizeBytes?: number;
    dbSizeBytes?: number;
    storedDimensions?: number;
    dimensionCounts?: Array<{ dimensions: number; vectors: number; items: number }>;
  };
  libraryStats?: {
    topLevelItems: number;
    regularItems: number;
    standaloneAttachments: number;
    standaloneNotes: number;
    indexedRegularItems: number;
    unindexedRegularItems: number;
    nonCurrentIndexItems: number;
  };
  serviceStatus: {
    initialized: boolean;
    embeddingReady: boolean;
    fallbackMode: boolean;
  };
  indexProgress: IndexProgress;
}

export interface DimensionAudit {
  currentDimensions: number;
  dimensionCounts: Array<{ dimensions: number; vectors: number; items: number }>;
  mismatchedVectors: number;
  mismatchedItems: number;
}

// ============ Service Implementation ============

export class SemanticSearchService {
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStore;
  private textChunker: TextChunker;

  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private indexProgress: IndexProgress = {
    total: 0,
    processed: 0,
    status: 'idle',
    failedCount: 0
  };

  // Pause/Resume control flags
  private _paused = false;
  private _aborted = false;
  private _pauseResolve: (() => void) | null = null;
  private _buildActive = false;

  // Error handling
  private _onErrorCallback?: (error: EmbeddingAPIError) => void;
  private _failedItems: Map<string, { error: string; errorType: EmbeddingErrorType; timestamp: number }> = new Map();

  constructor() {
    ztoolkit.log(`[SemanticSearch] Constructor called`);
    this.embeddingService = getEmbeddingService();
    this.vectorStore = getVectorStore();
    this.textChunker = getTextChunker();
    ztoolkit.log(`[SemanticSearch] Obtained VectorStore instance`);
  }

  /**
   * Initialize the semantic search service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    const startTime = Date.now();
    ztoolkit.log('[SemanticSearch] Initializing...');

    try {
      // Load persisted index progress (for resuming after restart)
      this.loadIndexProgress();

      // Initialize vector store first (faster)
      await this.vectorStore.initialize();

      // Initialize embedding service (may take longer due to model loading)
      await this.embeddingService.initialize();

      this.initialized = true;
      const elapsed = Date.now() - startTime;
      ztoolkit.log(`[SemanticSearch] Initialized in ${elapsed}ms`);

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] Initialization failed: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Load persisted index progress from preferences
   */
  private loadIndexProgress(): void {
    try {
      const progressJson = Zotero.Prefs.get(PREF_INDEX_PROGRESS, true);
      if (progressJson) {
        const saved = JSON.parse(String(progressJson));
        // Only restore if it was paused or indexing (not completed/idle)
        if (saved.status === 'paused' || saved.status === 'indexing') {
          this.indexProgress = {
            total: saved.total || 0,
            processed: saved.processed || 0,
            status: 'paused',  // Always show as paused after restart
            currentItem: saved.currentItem,
            startTime: saved.startTime,
            estimatedRemaining: saved.estimatedRemaining,
            mode: saved.mode === 'repair' ? 'repair' : 'normal'
          };
          this._paused = true;  // Mark as paused so it can be resumed
          ztoolkit.log(`[SemanticSearch] Restored paused index progress: ${this.indexProgress.processed}/${this.indexProgress.total}`);
        }
      }
    } catch (e) {
      ztoolkit.log(`[SemanticSearch] Failed to load index progress: ${e}`, 'warn');
    }
  }

  /**
   * Save index progress to preferences
   */
  private saveIndexProgress(): void {
    try {
      const toSave = {
        total: this.indexProgress.total,
        processed: this.indexProgress.processed,
        status: this.indexProgress.status,
        currentItem: this.indexProgress.currentItem,
        startTime: this.indexProgress.startTime,
        estimatedRemaining: this.indexProgress.estimatedRemaining,
        mode: this.indexProgress.mode
      };
      Zotero.Prefs.set(PREF_INDEX_PROGRESS, JSON.stringify(toSave), true);
    } catch (e) {
      ztoolkit.log(`[SemanticSearch] Failed to save index progress: ${e}`, 'warn');
    }
  }

  /**
   * Clear persisted index progress
   */
  private clearSavedIndexProgress(): void {
    try {
      Zotero.Prefs.clear(PREF_INDEX_PROGRESS, true);
    } catch (e) {
      // Ignore errors
    }
  }

  // ============ Search Methods ============

  /**
   * Semantic search
   */
  async search(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult[]> {
    await this.initialize();

    const {
      topK = 10,
      minScore = 0.1,  // Lowered from 0.3 to allow more results through
      language = 'all',
      itemKeys
    } = options;

    const startTime = Date.now();
    ztoolkit.log(`[SemanticSearch] Searching: "${query.substring(0, 50)}..."`);

    try {
      // 1. Generate query embedding (isQuery=true for BGE instruction prefix)
      ztoolkit.log(`[SemanticSearch] Step 1: Generating query embedding...`);
      const queryEmbedding = await this.embeddingService.embed(query, 'auto', true);
      ztoolkit.log(`[SemanticSearch] Query embedding: lang=${queryEmbedding.language}, dims=${queryEmbedding.dimensions}`);

      // 2. Vector search - use detected language when language option is 'all' for better performance
      // This significantly reduces search space (up to 50% reduction)
      const searchLanguage = language === 'all' ? queryEmbedding.language : language;
      ztoolkit.log(`[SemanticSearch] Step 2: Vector search (topK=${topK * 3}, minScore=${minScore}, lang=${searchLanguage})...`);
      const vectorResults = await this.vectorStore.search(queryEmbedding.embedding, {
        topK: topK * 3,  // Get more for deduplication
        language: searchLanguage,
        itemKeys,
        minScore
      });
      ztoolkit.log(`[SemanticSearch] Vector search returned ${vectorResults.length} results`);

      // 3. Aggregate by item
      const itemResultsMap = new Map<string, {
        itemKey: string;
        chunks: Array<{ chunkId: number; text: string; score: number }>;
        maxScore: number;
      }>();

      for (const result of vectorResults) {
        const existing = itemResultsMap.get(result.itemKey);
        if (existing) {
          existing.chunks.push({
            chunkId: result.chunkId,
            text: result.chunkText,
            score: result.score
          });
          existing.maxScore = Math.max(existing.maxScore, result.score);
        } else {
          itemResultsMap.set(result.itemKey, {
            itemKey: result.itemKey,
            chunks: [{
              chunkId: result.chunkId,
              text: result.chunkText,
              score: result.score
            }],
            maxScore: result.score
          });
        }
      }

      // 4. Pure semantic search (no hybrid)
      ztoolkit.log(`[SemanticSearch] Step 3: Aggregated into ${itemResultsMap.size} unique items`);

      const finalResults: SemanticSearchResult[] = Array.from(itemResultsMap.values())
        .sort((a, b) => b.maxScore - a.maxScore)
        .slice(0, topK * 3)
        .map(r => ({
          itemKey: r.itemKey,
          title: '',
          score: r.maxScore,
          matchedChunks: r.chunks.sort((a, b) => b.score - a.score).slice(0, 3)
        }));

      // 5. Fill in item metadata
      await this.fillItemMetadata(finalResults);

      const searchTime = Date.now() - startTime;
      ztoolkit.log(`[SemanticSearch] Found ${finalResults.length} results in ${searchTime}ms`);

      return finalResults.slice(0, topK);

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] Search error: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Find similar items
   */
  async findSimilar(
    itemKey: string,
    options: { topK?: number; minScore?: number } = {}
  ): Promise<SemanticSearchResult[]> {
    await this.initialize();

    const { topK = 5, minScore = 0.3 } = options;  // Lowered from 0.5

    try {
      // Get item's vectors
      const itemVectors = await this.vectorStore.getItemVectors(itemKey);

      if (itemVectors.length === 0) {
        ztoolkit.log(`[SemanticSearch] Item ${itemKey} not indexed`);
        return [];
      }

      // Use first chunk vector as query (or could average all)
      const queryVector = itemVectors[0].vector;

      // Search for similar
      const results = await this.vectorStore.search(queryVector, {
        topK: topK + 1,
        minScore
      });

      // Filter out the source item and map results
      const filteredResults = results
        .filter(r => r.itemKey !== itemKey)
        .slice(0, topK)
        .map(r => ({
          itemKey: r.itemKey,
          title: '',
          score: r.score,
          matchedChunks: [{
            chunkId: r.chunkId,
            text: r.chunkText,
            score: r.score
          }]
        }));

      // Fill metadata
      await this.fillItemMetadata(filteredResults);

      return filteredResults;

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] findSimilar error: ${error}`, 'error');
      throw error;
    }
  }

  // ============ Indexing Methods ============

  /**
   * Build or update the semantic index
   */
  async buildIndex(options: {
    itemKeys?: string[];
    rebuild?: boolean;
    reembedDimensions?: number;
    onProgress?: (progress: IndexProgress) => void;
  } = {}): Promise<IndexProgress> {
    await this.initialize();

    const { itemKeys, rebuild = false, reembedDimensions, onProgress } = options;
    if (reembedDimensions && !itemKeys?.length) {
      throw new Error('Selective re-embedding requires explicit item keys');
    }

    if (this._buildActive) {
      ztoolkit.log('[SemanticSearch] buildIndex already running, ignoring duplicate call', 'warn');
      // Return a copy with a distinct status so callers can tell this apart
      // from a completed build and avoid showing bogus "completed" messages
      return { ...this.indexProgress, status: 'busy' };
    }
    this._buildActive = true;

    try {
      // Reset control flags
      this._paused = false;
      this._aborted = false;
      this._pauseResolve = null;

      this.indexProgress = {
        total: 0,
        processed: 0,
        status: 'indexing',
        startTime: Date.now(),
        mode: reembedDimensions ? 'repair' : 'normal'
      };

      // Check for dimension mismatch before indexing (unless rebuild)
      if (!rebuild && !reembedDimensions) {
        const dimensionCheck = await this.checkDimensionCompatibility();
        if (!dimensionCheck.compatible) {
          ztoolkit.log(`[SemanticSearch] Dimension mismatch detected: stored=${dimensionCheck.storedDimensions}, current=${dimensionCheck.currentDimensions}`, 'warn');
          this.indexProgress.status = 'error';
          this.indexProgress.error = dimensionCheck.message;
          this.indexProgress.errorType = 'config';
          this.indexProgress.errorRetryable = false;
          onProgress?.(this.indexProgress);
          return this.indexProgress;
        }
      }

      // Get items to index
      let items: any[];
      if (itemKeys && itemKeys.length > 0) {
        items = await this.getItemsByKeys(itemKeys);
      } else {
        items = await this.getItemsWithContent();
      }

      const totalLibraryItems = items.length;
      ztoolkit.log(`[SemanticSearch] Library items fetched: ${totalLibraryItems}`);

      // Filter already indexed items (unless rebuild). #100: an item that
      // was indexed before its PDF arrived must be re-selected, so compare
      // stored change-detection timestamps instead of bare membership.
      if (!rebuild && !reembedDimensions) {
        const statusMap = await this.vectorStore.getIndexStatusMap();
        const indexedCount = statusMap.size;
        const toIndex: any[] = [];
        for (const item of items) {
          const st = statusMap.get(item.key);
          if (!st) { toIndex.push(item); continue; }
          // Known-failed items stay excluded until Retry Failed clears them
          if (st.contentHash && st.contentHash.startsWith('failed:')) continue;
          const current = await this.getItemTimestamps(item);
          // NULL and '' both mean "no attachment seen at index time" — do
          // NOT reuse needsReindexByTimestamp here, its !attachmentModified
          // rule would re-select every attachment-less item forever
          if ((st.itemModified || '') !== current.itemModified ||
              (st.attachmentModified || '') !== current.attachmentModified) {
            // Invalidate the cached content: it predates the change (e.g.
            // abstract-only, cached before the PDF existed) and its hash
            // matches the stored index hash, so the cached-content
            // short-circuit in indexItemWithProcessor would otherwise just
            // refresh timestamps and never re-extract
            await this.vectorStore.deleteCachedContent(item.key);
            toIndex.push(item);
          }
        }
        items = toIndex;
        ztoolkit.log(`[SemanticSearch] Items: library=${totalLibraryItems}, indexed=${indexedCount}, toIndex=${items.length}`);
      } else if (rebuild) {
        // For rebuild: clear all existing index data first
        ztoolkit.log(`[SemanticSearch] Rebuild mode: clearing existing index data...`);

        // Get stats before clear for verification
        const statsBefore = await this.vectorStore.getStats();
        ztoolkit.log(`[SemanticSearch] Before clear: ${statsBefore.totalVectors} vectors, ${statsBefore.totalItems} items`);

        await this.vectorStore.clear();

        // Verify clear worked
        const statsAfter = await this.vectorStore.getStats();
        ztoolkit.log(`[SemanticSearch] After clear: ${statsAfter.totalVectors} vectors, ${statsAfter.totalItems} items`);

        if (statsAfter.totalVectors > 0) {
          ztoolkit.log(`[SemanticSearch] WARNING: clear() did not remove all vectors!`, 'warn');
        }

        ztoolkit.log(`[SemanticSearch] Existing index data cleared`);
      }

      this.indexProgress.total = items.length;
      onProgress?.(this.indexProgress);

      if (items.length === 0) {
        this.indexProgress.status = 'completed';
        return this.indexProgress;
      }

      ztoolkit.log(`[SemanticSearch] Indexing ${items.length} items...`);

      // Keep one PDFProcessor per concurrent item; resize between settled batches.
      const processorPool: PDFProcessor[] = [];
      let lastProgressNotification = 0;

      try {
        // Process in parallel batches for better throughput
        for (let i = 0, batchNumber = 0; i < items.length; batchNumber++) {
          // Check for abort
          if (this._aborted) {
            this.indexProgress.status = 'aborted';
            ztoolkit.log(`[SemanticSearch] Indexing aborted at ${this.indexProgress.processed}/${this.indexProgress.total}`);
            break;
          }

          // Check for pause - wait until resumed
          if (this._paused) {
            ztoolkit.log(`[SemanticSearch] Indexing paused at ${this.indexProgress.processed}/${this.indexProgress.total}`);
            onProgress?.(this.indexProgress);
            await this.waitWhilePaused();
            // After resume, check if aborted while paused
            if (this._aborted) {
              this.indexProgress.status = 'aborted';
              ztoolkit.log(`[SemanticSearch] Indexing aborted after pause`);
              break;
            }
            this.indexProgress.status = 'indexing';
            ztoolkit.log(`[SemanticSearch] Indexing resumed`);
          }

          // Read this after a pause so a changed setting applies on resume.
          const concurrency = getIndexConcurrency();
          const batch = items.slice(i, i + concurrency);
          while (processorPool.length < batch.length) {
            processorPool.push(new PDFProcessor(ztoolkit));
          }
          while (processorPool.length > batch.length) {
            processorPool.pop()!.terminate();
          }

          // Process batch items in parallel, each with its own processor
          const results = await Promise.allSettled(
            batch.map(async (item, batchIndex) => {
              this.indexProgress.currentItem = item.key;
              // Each item gets its own processor from the pool
              const processor = processorPool[batchIndex];
              if (reembedDimensions) {
                await this.reembedItemWithProcessor(item, processor, reembedDimensions);
              } else {
                await this.indexItemWithProcessor(item, processor);
              }
              this.indexProgress.processed++;
              this.indexProgress.currentItem = item.key;
              const now = Date.now();
              if (now - lastProgressNotification >= 500) {
                lastProgressNotification = now;
                const elapsed = now - (this.indexProgress.startTime || now);
                this.indexProgress.estimatedRemaining =
                  elapsed / this.indexProgress.processed *
                  (this.indexProgress.total - this.indexProgress.processed);
                try {
                  onProgress?.(this.indexProgress);
                } catch (error) {
                  ztoolkit.log(`[SemanticSearch] Progress display failed: ${error}`, 'warn');
                }
              }
              return item.key; // Return item key for tracking
            })
          );

          // Count processed items and handle errors
          let hasAPIError = false;
          let apiError: EmbeddingAPIError | null = null;
          const retryItems: any[] = [];

          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const item = batch[j];

            if (result.status === 'rejected') {
              // Check if this is an EmbeddingAPIError
              const error = result.reason;
              if (error instanceof EmbeddingAPIError) {
                // Special handling for pause - don't record as failed
                if (error.type === 'paused') {
                  ztoolkit.log(`[SemanticSearch] Item ${item.key} interrupted by pause`);
                  retryItems.push(item);
                  continue;
                }

                // Global errors affect every item identically: pause so the
                // user can fix config/network before continuing. 'server'
                // (5xx) is global too — a provider outage mid-build must not
                // burn through the queue persisting failure markers for
                // every remaining item
                const isGlobalError = error.type === 'auth' || error.type === 'config' ||
                                      error.type === 'network' || error.type === 'rate_limit' ||
                                      error.type === 'server';
                if (isGlobalError) {
                  hasAPIError = true;
                  apiError = error;
                  retryItems.push(item);
                  ztoolkit.log(`[SemanticSearch] Global API error for item ${item.key}: ${error.type} - ${error.message}`, 'error');
                } else {
                  // Item-local errors (invalid_request/400, payload_too_large/413,
                  // server/5xx after retries, unknown): skip this item, record it, continue
                  if (reembedDimensions) {
                    // Keep the old index status and vectors intact for another repair attempt.
                    this._failedItems.set(item.key, {
                      error: error.getUserMessage(), errorType: error.type, timestamp: Date.now(),
                    });
                    this.indexProgress.failedCount = this._failedItems.size;
                  } else {
                    await this.recordFailedItem(item, error);
                  }
                  this.indexProgress.processed++;
                  ztoolkit.log(`[SemanticSearch] Skipped item ${item.key} after ${error.type} error: ${error.message}`, 'warn');
                }
              } else {
                // Other errors (PDF extraction, etc.) - just log and continue
                this.indexProgress.processed++;
                ztoolkit.log(`[SemanticSearch] Failed to index item ${item.key}: ${error}`, 'warn');
              }
            }
          }
          // Failed global requests and pause-interrupted items stay in the queue.
          // This matters especially when one large batch covers the whole library.
          items.push(...retryItems);

          // If there was an API error, auto-pause and notify
          if (hasAPIError && apiError) {
            ztoolkit.log(`[SemanticSearch] API error detected, auto-pausing indexing...`, 'warn');

            // Set error info in progress
            this.indexProgress.error = apiError.getUserMessage();
            this.indexProgress.errorType = apiError.type;
            this.indexProgress.errorRetryable = apiError.retryable;

            // Auto-pause
            this._paused = true;
            this.indexProgress.status = 'paused';
            this.saveIndexProgress();

            // Notify via callback
            if (this._onErrorCallback) {
              this._onErrorCallback(apiError);
            }

            onProgress?.(this.indexProgress);

            // Wait for user to resume or abort
            await this.waitWhilePaused();

            // After resume, check if aborted
            if (this._aborted) {
              this.indexProgress.status = 'aborted';
              ztoolkit.log(`[SemanticSearch] Indexing aborted after API error`);
              break;
            }

            // Clear error state and continue
            this.indexProgress.error = undefined;
            this.indexProgress.errorType = undefined;
            this.indexProgress.errorRetryable = undefined;
            this.indexProgress.status = 'indexing';
            ztoolkit.log(`[SemanticSearch] Indexing resumed after API error`);
          }

          // Update estimated remaining time
          const elapsed = Date.now() - (this.indexProgress.startTime || 0);
          const avgTime = elapsed / this.indexProgress.processed;
          this.indexProgress.estimatedRemaining =
            avgTime * (this.indexProgress.total - this.indexProgress.processed);

          onProgress?.(this.indexProgress);

          // Save progress periodically (every 5 batches) for resume after restart
          if (batchNumber % 5 === 0) {
            this.saveIndexProgress();
          }

          // Yield to UI periodically
          if (batchNumber % 2 === 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          i += batch.length;
        }
      } finally {
        // Clean up all processors in the pool
        for (const processor of processorPool) {
          processor.terminate();
        }
        ztoolkit.log(`[SemanticSearch] Terminated ${processorPool.length} PDFProcessor workers`);
      }

      // Only set completed if not aborted
      if (this.indexProgress.status !== 'aborted') {
        this.indexProgress.status = 'completed';
        this.clearSavedIndexProgress();  // Clear persisted state on completion
      }
      onProgress?.(this.indexProgress);

      ztoolkit.log(`[SemanticSearch] Indexing finished: ${this.indexProgress.processed} items, status=${this.indexProgress.status}`);
      return this.indexProgress;

    } catch (error) {
      this.indexProgress.status = 'error';
      this.indexProgress.error = String(error);
      ztoolkit.log(`[SemanticSearch] Indexing failed: ${error}`, 'error');
      throw error;
    } finally {
      this._buildActive = false;
    }
  }

  /**
   * Index a single item (creates its own PDFProcessor)
   */
  async indexItem(item: any): Promise<void> {
    return this.indexItemWithProcessor(item, null);
  }

  /**
   * Index a single item with optional shared PDFProcessor
   */
  async indexItemWithProcessor(item: any, sharedProcessor: PDFProcessor | null): Promise<void> {
    const startTime = Date.now();
    const itemTitle = item.getDisplayTitle?.() || item.key;
    ztoolkit.log(`[SemanticSearch] indexItem() start: ${item.key} "${itemTitle.substring(0, 30)}..."`);

    // Get timestamps for fast change detection
    const itemModified = item.dateModified || '';
    let attachmentModified = '';

    // Get latest attachment modification time
    if (item.isRegularItem?.()) {
      const attachmentIds = item.getAttachments?.() || [];
      for (const attId of attachmentIds) {
        try {
          const att = await Zotero.Items.getAsync(attId);
          if (att?.dateModified && att.dateModified > attachmentModified) {
            attachmentModified = att.dateModified;
          }
        } catch (e) {
          // Skip failed attachments
        }
      }
    }

    // Fast check: if timestamps haven't changed, skip entirely (no content extraction needed)
    const needsCheckByTimestamp = await this.vectorStore.needsReindexByTimestamp(
      item.key, itemModified, attachmentModified
    );
    if (!needsCheckByTimestamp) {
      ztoolkit.log(`[SemanticSearch] indexItem() skip: timestamps unchanged for ${item.key}`);
      return;
    }

    // Timestamps changed - try to use cached content first (avoid PDF re-extraction)
    let content: string;
    let contentHash: string;

    const cached = await this.vectorStore.getCachedContent(item.key);
    if (cached) {
      // Check if cached content hash matches stored index hash
      const needsIndex = await this.vectorStore.needsReindex(item.key, cached.hash);
      if (!needsIndex) {
        // Content unchanged, just update timestamps
        const status = await this.vectorStore.getIndexStatus(item.key);
        if (status) {
          await this.vectorStore.updateIndexStatus(
            item.key, status.chunkCount, cached.hash, itemModified, attachmentModified
          );
        }
        ztoolkit.log(`[SemanticSearch] indexItem() skip: cached content unchanged, updated timestamps`);
        return;
      }
      // Cache exists but hash indicates content may have changed - re-extract to verify
      ztoolkit.log(`[SemanticSearch] indexItem() cache hash mismatch, re-extracting content`);
    }

    // Check for pause before content extraction
    if (this._paused || this._aborted) {
      ztoolkit.log(`[SemanticSearch] indexItem() paused/aborted before content extraction: ${item.key}`);
      return;
    }

    // Extract content (PDF extraction happens here)
    const extraction = await this.extractItemContent(item, sharedProcessor);
    content = extraction.content;
    if (extraction.pdfExtractionFailed) {
      // PDF extraction failed: do NOT record the title+abstract remnant as a
      // successful index. Persist a 'failed:extraction' marker (same pattern as
      // embedding failures at recordFailedItem) so the column UI excludes it
      // and the Retry Failed button picks it up.
      this._failedItems.set(item.key, {
        error: `PDF extraction failed: ${extraction.pdfError}`,
        errorType: 'extraction' as any,
        timestamp: Date.now()
      });
      this.indexProgress.failedCount = this._failedItems.size;
      await this.vectorStore.updateIndexStatus(item.key, 0, 'failed:extraction', itemModified, attachmentModified);
      ztoolkit.log(`[SemanticSearch] indexItem() PDF extraction failed for ${item.key}, marked failed:extraction`, 'warn');
      return;
    }
    if (!content.trim()) {
      // Mark item in index_status even with no content, to prevent repeated rebuild attempts
      await this.vectorStore.updateIndexStatus(item.key, 0, 'empty', itemModified, attachmentModified);
      ztoolkit.log(`[SemanticSearch] indexItem() skip: no content for ${item.key}, marked in index_status to avoid retry loop`);
      return;
    }
    ztoolkit.log(`[SemanticSearch] indexItem() extracted content: ${content.length} chars`);

    // Check for pause after content extraction (before embedding)
    if (this._paused || this._aborted) {
      // Save cached content but don't continue
      await this.vectorStore.setCachedContent(item.key, content, this.hashContent(content));
      ztoolkit.log(`[SemanticSearch] indexItem() paused/aborted after content extraction: ${item.key}`);
      return;
    }

    // Calculate content hash
    contentHash = this.hashContent(content);

    // Cache the extracted content for future use
    await this.vectorStore.setCachedContent(item.key, content, contentHash);
    ztoolkit.log(`[SemanticSearch] indexItem() cached content: ${content.length} chars`);

    // Check if content actually changed (compare with stored hash)
    const needsIndex = await this.vectorStore.needsReindex(item.key, contentHash);
    if (!needsIndex) {
      // Content hash unchanged, just update timestamps
      const status = await this.vectorStore.getIndexStatus(item.key);
      if (status) {
        await this.vectorStore.updateIndexStatus(
          item.key, status.chunkCount, contentHash, itemModified, attachmentModified
        );
      }
      ztoolkit.log(`[SemanticSearch] indexItem() skip: content unchanged, updated timestamps`);
      return;
    }

    // Delete existing vectors
    await this.vectorStore.deleteItemVectors(item.key);

    // Chunk the content
    const chunks = this.textChunker.chunk(content);
    if (chunks.length === 0) {
      // deleteItemVectors() above removed this item's index_status row; without
      // re-writing one the item counts as "never indexed" and every subsequent
      // buildIndex re-extracts it (infinite rescan loop, see #104 problem 2).
      // contentHash was computed above, so later content changes still reindex.
      await this.vectorStore.updateIndexStatus(item.key, 0, contentHash, itemModified, attachmentModified);
      ztoolkit.log(`[SemanticSearch] indexItem() no chunks generated for ${item.key}, wrote chunk_count=0 sentinel`);
      return;
    }
    ztoolkit.log(`[SemanticSearch] indexItem() chunked into ${chunks.length} chunks`);

    // Generate embeddings with pause check
    const batchItems = chunks.map((chunk, idx) => ({
      id: `${item.key}_${idx}`,
      text: chunk
    }));

    const embeddings = await this.embeddingService.embedBatch(batchItems, {
      onPauseCheck: () => this._paused || this._aborted
    });
    ztoolkit.log(`[SemanticSearch] indexItem() generated ${embeddings.size} embeddings`);

    // Store vectors
    const records = chunks.map((chunk, idx) => {
      const embedding = embeddings.get(`${item.key}_${idx}`);
      if (!embedding) return null;

      return {
        itemKey: item.key,
        chunkId: idx,
        vector: embedding.embedding,
        language: embedding.language,
        chunkText: chunk  // Store full chunk (max ~450 chars from TextChunker)
      };
    }).filter(r => r !== null) as any[];

    await this.vectorStore.insertVectorsBatch(records);
    // Record the count of chunks actually embedded (embedBatch may have
    // skipped oversized chunks), not the total chunk count
    await this.vectorStore.updateIndexStatus(item.key, records.length, contentHash, itemModified, attachmentModified);

    const elapsed = Date.now() - startTime;
    if (records.length < chunks.length) {
      ztoolkit.log(`[SemanticSearch] indexItem() ${item.key}: ${chunks.length - records.length}/${chunks.length} chunks skipped (oversized)`, 'warn');
    }
    ztoolkit.log(`[SemanticSearch] indexItem() completed: ${item.key} (${records.length} vectors) in ${elapsed}ms`);
  }

  /** Regenerate one item's vectors while keeping the old vectors until the replacement is ready. */
  private async reembedItemWithProcessor(item: any, processor: PDFProcessor, dimensions: number): Promise<void> {
    const timestamps = await this.getItemTimestamps(item);
    const status = await this.vectorStore.getIndexStatus(item.key);
    const cached = await this.vectorStore.getCachedContent(item.key);
    const cacheIsCurrent = !!cached && !!status &&
      (status.itemModified || '') === timestamps.itemModified &&
      (status.attachmentModified || '') === timestamps.attachmentModified;

    let content: string;
    if (cacheIsCurrent) {
      content = cached!.content;
    } else {
      if (this._paused || this._aborted) {
        throw new EmbeddingAPIError('Indexing paused', 'paused');
      }
      const extraction = await this.extractItemContent(item, processor);
      if (extraction.pdfExtractionFailed) {
        throw new Error(`PDF extraction failed for ${item.key}: ${extraction.pdfError}`);
      }
      content = extraction.content;
    }
    if (!content.trim()) throw new Error(`No content available to re-embed for ${item.key}`);

    const contentHash = this.hashContent(content);
    if (!cacheIsCurrent) await this.vectorStore.setCachedContent(item.key, content, contentHash);
    const chunks = this.textChunker.chunk(content);
    if (!chunks.length) throw new Error(`No chunks available to re-embed for ${item.key}`);

    const embeddings = await this.embeddingService.embedBatch(
      chunks.map((text, index) => ({ id: `${item.key}_${index}`, text })),
      { onPauseCheck: () => this._paused || this._aborted },
    );
    const records = chunks.flatMap((chunk, index) => {
      const embedding = embeddings.get(`${item.key}_${index}`);
      return embedding ? [{
        itemKey: item.key,
        chunkId: index,
        vector: embedding.embedding,
        language: embedding.language,
        chunkText: chunk,
      }] : [];
    });
    if (!records.length) throw new Error(`Embedding returned no vectors for ${item.key}`);
    if (records.some(record => record.vector.length !== dimensions)) {
      throw new EmbeddingAPIError(
        `Embedding output changed dimensions during repair: expected ${dimensions}`,
        'config',
      );
    }
    if (this._paused || this._aborted) {
      throw new EmbeddingAPIError('Indexing paused', 'paused');
    }
    await this.vectorStore.replaceItemVectors(
      item.key, records, contentHash, timestamps.itemModified, timestamps.attachmentModified,
    );
    ztoolkit.log(`[SemanticSearch] Re-embedded ${item.key}: ${records.length} vectors at ${dimensions} dimensions`);
  }

  /**
   * Delete index for an item
   */
  async deleteItemIndex(itemKey: string): Promise<void> {
    await this.initialize();
    await this.vectorStore.deleteItemVectors(itemKey);
    ztoolkit.log(`[SemanticSearch] Deleted index for item: ${itemKey}`);
  }

  /**
   * Clear all indexes
   */
  async clearIndex(): Promise<void> {
    await this.initialize();
    await this.vectorStore.clear();
    ztoolkit.log('[SemanticSearch] Index cleared');
  }

  // ============ Status Methods ============

  /**
   * Get service statistics
   */
  async getStats(): Promise<SemanticServiceStats> {
    await this.initialize();

    const indexStats = await this.vectorStore.getStats();
    const embeddingStatus = this.embeddingService.getStatus();

    let libraryStats: SemanticServiceStats['libraryStats'];
    try {
      const regularItems = await this.getItemsWithContent();
      const regularKeys = new Set(regularItems.map((item: any) => item.key));
      const vectorKeys = await this.vectorStore.getVectorItemKeys();
      const indexedRegularItems = [...vectorKeys].filter(key => regularKeys.has(key)).length;
      const standaloneAttachments = await this.getStandaloneItemCount('attachment');
      const standaloneNotes = await this.getStandaloneItemCount('note');
      libraryStats = {
        topLevelItems: regularItems.length + standaloneAttachments + standaloneNotes,
        regularItems: regularItems.length,
        standaloneAttachments,
        standaloneNotes,
        indexedRegularItems,
        unindexedRegularItems: regularItems.length - indexedRegularItems,
        nonCurrentIndexItems: vectorKeys.size - indexedRegularItems
      };
    } catch (e) {
      ztoolkit.log(`[SemanticSearch] Could not reconcile index with library: ${e}`, 'warn');
    }

    return {
      indexStats,
      libraryStats,
      serviceStatus: {
        initialized: this.initialized,
        embeddingReady: embeddingStatus.initialized,
        fallbackMode: this.embeddingService.isFallbackMode()
      },
      indexProgress: this.indexProgress
    };
  }

  /**
   * Get current index progress
   */
  getIndexProgress(): IndexProgress {
    return { ...this.indexProgress };
  }

  /**
   * Pause the indexing process
   */
  pauseIndex(): void {
    if (this.indexProgress.status === 'indexing') {
      this._paused = true;
      this.indexProgress.status = 'paused';
      this.saveIndexProgress();  // Persist paused state
      ztoolkit.log('[SemanticSearch] Index paused');
    }
  }

  /**
   * Resume the indexing process
   */
  resumeIndex(): void {
    if (this.indexProgress.status === 'paused' && this._paused) {
      this._paused = false;
      this.indexProgress.status = 'indexing';
      this.saveIndexProgress();  // Update persisted state
      if (this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
      }
      ztoolkit.log('[SemanticSearch] Index resumed');
    }
  }

  /**
   * Abort the indexing process
   */
  abortIndex(): void {
    if (this.indexProgress.status === 'indexing' || this.indexProgress.status === 'paused') {
      this._aborted = true;
      this._paused = false;
      this.indexProgress.status = 'aborted';
      this.clearSavedIndexProgress();  // Clear persisted state on abort
      // Release pause lock if paused
      if (this._pauseResolve) {
        this._pauseResolve();
        this._pauseResolve = null;
      }
      ztoolkit.log('[SemanticSearch] Index aborted');
    }
  }

  /**
   * Check if indexing is paused
   */
  isPaused(): boolean {
    return this._paused;
  }

  /**
   * Whether a buildIndex run is currently in flight (including parked in a
   * paused state waiting for resume)
   */
  isBuildActive(): boolean {
    return this._buildActive;
  }

  /**
   * Set callback for indexing errors
   * Called when an error occurs during indexing (auto-pauses)
   */
  setOnIndexError(callback: (error: EmbeddingAPIError) => void): void {
    this._onErrorCallback = callback;
  }

  /**
   * Get failed items list
   */
  getFailedItems(): Array<{ itemKey: string; error: string; errorType: EmbeddingErrorType; timestamp: number }> {
    return Array.from(this._failedItems.entries()).map(([itemKey, info]) => ({
      itemKey,
      ...info
    }));
  }

  /**
   * Clear failed items list
   */
  clearFailedItems(): void {
    this._failedItems.clear();
    this.indexProgress.failedCount = 0;
  }

  /**
   * Record a failed item: in-memory for the UI, and persisted into
   * index_status with a 'failed:<type>' content_hash sentinel (same pattern
   * as the 'empty' marker) so subsequent buildIndex runs skip it instead of
   * re-hitting the same failure on every resume/restart.
   */
  private async recordFailedItem(item: any, error: EmbeddingAPIError): Promise<void> {
    this._failedItems.set(item.key, {
      error: error.getUserMessage(),
      errorType: error.type,
      timestamp: Date.now()
    });
    this.indexProgress.failedCount = this._failedItems.size;
    try {
      await this.vectorStore.updateIndexStatus(
        item.key, 0, `failed:${error.type}`,
        item.dateModified || '', ''
      );
    } catch (e) {
      ztoolkit.log(`[SemanticSearch] Could not persist failure marker for ${item.key}: ${e}`, 'warn');
    }
  }

  /**
   * Retry failed items (both in-memory failures from this session and
   * failure markers persisted by previous runs)
   */
  async retryFailedItems(onProgress?: (progress: IndexProgress) => void): Promise<IndexProgress> {
    await this.initialize();

    // Check BEFORE clearing failure markers: if another build is running,
    // buildIndex would reject the nested call after the bookkeeping was
    // already wiped, losing the failure records without retrying anything
    if (this._buildActive) {
      ztoolkit.log('[SemanticSearch] retryFailedItems: a build is already running', 'warn');
      return { ...this.indexProgress, status: 'busy' };
    }

    const persisted = await this.vectorStore.getFailedItemKeys();
    const failedItemKeys = Array.from(new Set([...persisted, ...this._failedItems.keys()]));
    if (failedItemKeys.length === 0) {
      ztoolkit.log('[SemanticSearch] No failed items to retry');
      return { ...this.indexProgress, total: 0, processed: 0, failedCount: 0, status: 'completed' };
    }

    ztoolkit.log(`[SemanticSearch] Retrying ${failedItemKeys.length} failed items`);

    // Clear failure markers so the buildIndex filter does not skip these items
    await this.vectorStore.clearFailedMarkers(failedItemKeys);
    this._failedItems.clear();
    this.indexProgress.failedCount = 0;

    // Build index for failed items only
    return this.buildIndex({
      itemKeys: failedItemKeys,
      rebuild: false,
      onProgress
    });
  }

  /**
   * Wait while paused
   * Uses a while loop to handle race conditions where resume might be called
   * before the loop enters this function, or if the promise is resolved unexpectedly
   */
  private async waitWhilePaused(): Promise<void> {
    while (this._paused && !this._aborted) {
      await new Promise<void>(resolve => {
        this._pauseResolve = resolve;
      });
    }
  }

  /** Inspect all stored dimensions against a fresh response from the configured model. */
  async auditIndexDimensions(): Promise<DimensionAudit> {
    await this.initialize();
    const currentDimensions = (await this.embeddingService.embed('dimension check', 'en')).dimensions;
    const dimensionCounts = await this.vectorStore.getDimensionCounts();
    const mismatchedVectors = dimensionCounts
      .filter(row => row.dimensions !== currentDimensions)
      .reduce((count, row) => count + row.vectors, 0);
    const mismatchedItems = mismatchedVectors
      ? (await this.vectorStore.getItemKeysWithOtherDimensions(currentDimensions)).length
      : 0;
    return { currentDimensions, dimensionCounts, mismatchedVectors, mismatchedItems };
  }

  /** Re-embed only live regular items that have at least one vector of another dimension. */
  async reembedMismatchedItems(onProgress?: (progress: IndexProgress) => void): Promise<IndexProgress> {
    await this.initialize();
    if (this._buildActive) return { ...this.indexProgress, status: 'busy' };
    const finishWithoutItems = (): IndexProgress => {
      this.indexProgress = { ...this.indexProgress, total: 0, processed: 0, status: 'completed', mode: 'repair' };
      this.clearSavedIndexProgress();
      onProgress?.(this.indexProgress);
      return this.indexProgress;
    };
    const audit = await this.auditIndexDimensions();
    if (!audit.mismatchedItems) {
      return finishWithoutItems();
    }
    const keys = await this.vectorStore.getItemKeysWithOtherDimensions(audit.currentDimensions);
    const items = await this.getItemsByKeys(keys);
    const liveKeys = items
      .filter(item => !item.deleted && item.isRegularItem?.())
      .map(item => item.key);
    if (!liveKeys.length) {
      return finishWithoutItems();
    }
    return this.buildIndex({
      itemKeys: liveKeys,
      reembedDimensions: audit.currentDimensions,
      onProgress,
    });
  }

  /**
   * Check dimension compatibility between stored vectors and current embedding config
   * Returns an object indicating if they are compatible and details about the mismatch
   */
  async checkDimensionCompatibility(): Promise<{
    compatible: boolean;
    storedDimensions: number | null;
    currentDimensions: number | null;
    message?: string;
  }> {
    try {
      const dimensionCounts = await this.vectorStore.getDimensionCounts();
      const storedDimensions = dimensionCounts.length === 1 ? dimensionCounts[0].dimensions : null;

      // If no stored vectors, any dimension is compatible
      if (!dimensionCounts.length) {
        return {
          compatible: true,
          storedDimensions: null,
          currentDimensions: this.embeddingService.getActualDimensions()
        };
      }

      const currentDimensions = (await this.embeddingService.embed('dimension check', 'en')).dimensions;

      // An entirely incompatible index cannot answer searches. A mixed index
      // remains searchable for matching vectors while the user repairs it.
      const matchingVectors = dimensionCounts.find(row => row.dimensions === currentDimensions)?.vectors || 0;
      if (matchingVectors === 0) {
        const stored = dimensionCounts.map(row => `${row.dimensions} (${row.vectors})`).join(', ');
        return {
          compatible: false,
          storedDimensions,
          currentDimensions,
          message: `维度不匹配: 已存储=${stored}, 当前输出=${currentDimensions}。请使用“重嵌入维度不符文献”修复。 / Dimension mismatch: stored=${stored}, current output=${currentDimensions}. Use selective re-embedding to repair.`
        };
      }

      return {
        compatible: true,
        storedDimensions,
        currentDimensions
      };
    } catch (error) {
      if (error instanceof EmbeddingAPIError) throw error;
      ztoolkit.log(`[SemanticSearch] Error checking dimension compatibility: ${error}`, 'warn');
      // If we can't check, assume compatible to avoid blocking
      return {
        compatible: true,
        storedDimensions: null,
        currentDimensions: null,
        message: 'Could not verify dimension compatibility'
      };
    }
  }

  /**
   * Check if service is ready
   */
  async isReady(): Promise<boolean> {
    try {
      await this.initialize();
      return await this.embeddingService.isReady();
    } catch {
      return false;
    }
  }

  // ============ Private Methods ============

  /**
   * Extract content from item for indexing
   * @param item The Zotero item
   * @param sharedProcessor Optional shared PDFProcessor for better performance
   */
  private async extractItemContent(item: any, sharedProcessor?: PDFProcessor | null): Promise<{ content: string; pdfExtractionFailed: boolean; pdfError: string }> {
    const parts: string[] = [];
    let pdfExtractionFailed = false;
    let pdfError = '';
    ztoolkit.log(`[SemanticSearch] extractItemContent() start: ${item.key}, type=${item.itemType}`);

    try {
      // Title
      const title = item.getDisplayTitle?.() || item.getField?.('title');
      if (title) {
        parts.push(title);
        ztoolkit.log(`[SemanticSearch] extractItemContent() got title: "${title.substring(0, 50)}..."`);
      }

      // Abstract
      const abstract = item.getField?.('abstractNote');
      if (abstract) {
        parts.push(TextFormatter.htmlToText(abstract));
        ztoolkit.log(`[SemanticSearch] extractItemContent() got abstract: ${abstract.length} chars`);
      }

      // Get content from attachments (full text + annotations)
      if (item.isRegularItem?.()) {
        const attachmentIds = item.getAttachments?.() || [];
        ztoolkit.log(`[SemanticSearch] extractItemContent() checking ${attachmentIds.length} attachments`);
        let annotationCount = 0;
        let fullTextCount = 0;

        for (const attachmentId of attachmentIds) {
          try {
            const attachment = await Zotero.Items.getAsync(attachmentId);
            if (!attachment) continue;

            // Extract full text from PDF attachments using PDFProcessor
            if (attachment.isPDFAttachment?.()) {
              try {
                const filePath = await attachment.getFilePathAsync?.();
                if (filePath) {
                  ztoolkit.log(`[SemanticSearch] extractItemContent() extracting PDF: ${filePath}`);
                  // Use shared processor if provided (much faster for batch processing)
                  const processor = sharedProcessor || new PDFProcessor(ztoolkit);
                  const shouldTerminate = !sharedProcessor;  // Only terminate if we created it
                  try {
                    const textContent = await processor.extractText(filePath);
                    if (textContent && textContent.length > 0) {
                      const maxFullTextLength = this.getMaxFullTextLength();
                      const finalContent = textContent.length > maxFullTextLength
                        ? textContent.substring(0, maxFullTextLength)
                        : textContent;
                      if (textContent.length > maxFullTextLength) {
                        ztoolkit.log(`[SemanticSearch] extractItemContent() truncated to ${maxFullTextLength} chars`);
                      }
                      parts.push(finalContent);
                      fullTextCount++;
                      ztoolkit.log(`[SemanticSearch] extractItemContent() got PDF text: ${finalContent.length} chars`);
                    } else {
                      ztoolkit.log(`[SemanticSearch] extractItemContent() PDF extraction returned empty`);
                    }
                  } finally {
                    if (shouldTerminate) {
                      processor.terminate();
                    }
                  }
                } else {
                  ztoolkit.log(`[SemanticSearch] extractItemContent() no file path for attachment ${attachmentId}`);
                }
              } catch (e) {
                pdfExtractionFailed = true;
                pdfError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                ztoolkit.log(`[SemanticSearch] extractItemContent() PDF extraction failed: ${pdfError}`, 'warn');
              }
            }

            // Extract text from text attachments (text/plain, text/markdown, ...
            // but not text/html — snapshots go through the webpage path). Keeps
            // MinerU-style imported .md files indexable (#86).
            if (attachment.attachmentContentType &&
                attachment.attachmentContentType.startsWith('text/') &&
                !attachment.attachmentContentType.includes('html')) {
              try {
                const filePath = await attachment.getFilePathAsync?.();
                if (filePath) {
                  const textContent = await Zotero.File.getContentsAsync(filePath);
                  if (textContent && textContent.length > 0) {
                    parts.push(textContent);
                    fullTextCount++;
                    ztoolkit.log(`[SemanticSearch] extractItemContent() got plain text: ${textContent.length} chars`);
                  }
                }
              } catch (e) {
                ztoolkit.log(`[SemanticSearch] extractItemContent() plain text extraction failed: ${e}`, 'warn');
              }
            }

            // Get annotations from PDF attachments
            if (attachment.isPDFAttachment?.()) {
              const annotations = attachment.getAnnotations?.() || [];
              for (const ann of annotations) {
                const text = ann.annotationText;
                const comment = ann.annotationComment;
                if (text) {
                  parts.push(TextFormatter.htmlToText(text));
                  annotationCount++;
                }
                if (comment) {
                  parts.push(TextFormatter.htmlToText(comment));
                  annotationCount++;
                }
              }
            }
          } catch (e) {
            // Skip failed attachments
            ztoolkit.log(`[SemanticSearch] extractItemContent() attachment error: ${e}`, 'warn');
          }
        }

        if (fullTextCount > 0) {
          ztoolkit.log(`[SemanticSearch] extractItemContent() got ${fullTextCount} full text contents`);
        }
        if (annotationCount > 0) {
          ztoolkit.log(`[SemanticSearch] extractItemContent() got ${annotationCount} annotations`);
        }
      }

      // If it's an annotation item itself
      if (item.isAnnotation?.()) {
        const text = item.annotationText;
        const comment = item.annotationComment;
        if (text) parts.push(TextFormatter.htmlToText(text));
        if (comment) parts.push(TextFormatter.htmlToText(comment));
      }

      // Notes
      if (item.isNote?.()) {
        const noteText = item.getNote?.();
        if (noteText) parts.push(TextFormatter.htmlToText(noteText));
      }

    } catch (error) {
      ztoolkit.log(`[SemanticSearch] extractItemContent() error: ${error}`, 'warn');
    }

    const result = parts.join('\n\n');
    ztoolkit.log(`[SemanticSearch] extractItemContent() done: ${parts.length} parts, total ${result.length} chars${pdfExtractionFailed ? ' (PDF extraction FAILED)' : ''}`);
    return { content: result, pdfExtractionFailed, pdfError };
  }

  /** Pref: extensions.zotero.zotero-mcp-plugin.semantic.maxFullTextLength (0 = unlimited, default 50000) */
  private getMaxFullTextLength(): number {
    try {
      const raw = Zotero.Prefs.get('extensions.zotero.zotero-mcp-plugin.semantic.maxFullTextLength', true);
      const n = parseInt(String(raw), 10);
      if (Number.isFinite(n) && n >= 0) return n === 0 ? Number.MAX_SAFE_INTEGER : n;
    } catch {
      // fall through to default
    }
    return 50000;
  }

  /**
   * Fill in item metadata for search results
   */
  private async fillItemMetadata(results: SemanticSearchResult[]): Promise<void> {
    for (let index = results.length - 1; index >= 0; index--) {
      const result = results[index];
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          Zotero.Libraries.userLibraryID,
          result.itemKey
        );

        // Old vectors can remain after an item is moved to the trash while
        // automatic indexing is off. Never return those entries as live hits.
        if (!item || item.deleted) {
          results.splice(index, 1);
          continue;
        }
        result.title = item.getDisplayTitle() || '';
        result.parentKey = item.parentItemKey || undefined;
        result.itemType = item.itemType || undefined;

        // Get creators
        const creators = item.getCreators?.() || [];
        if (creators.length > 0) {
          result.creators = creators
            .map((c: any) => c.lastName || c.name || '')
            .filter((n: string) => n)
            .join(', ');
        }

        // Get year
        const date = item.getField?.('date');
        if (date) {
          const yearMatch = String(date).match(/\d{4}/);
          if (yearMatch) {
            result.year = parseInt(yearMatch[0], 10);
          }
        }
      } catch (e) {
        results.splice(index, 1);
      }
    }
  }

  /**
   * Get items by keys
   */
  private async getItemsByKeys(keys: string[]): Promise<any[]> {
    const items: any[] = [];
    for (const key of keys) {
      try {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          Zotero.Libraries.userLibraryID,
          key
        );
        if (item) items.push(item);
      } catch (e) {
        // Skip failed items
      }
    }
    return items;
  }

  /**
   * Current change-detection timestamps for an item (#100): its own
   * dateModified plus the newest attachment dateModified ('' when the
   * item has no attachments)
   */
  private async getItemTimestamps(item: any): Promise<{ itemModified: string; attachmentModified: string }> {
    const itemModified = item.dateModified || '';
    let attachmentModified = '';
    if (item.isRegularItem?.()) {
      const attachmentIds = item.getAttachments?.() || [];
      for (const attId of attachmentIds) {
        try {
          const att = await Zotero.Items.getAsync(attId);
          if (att?.dateModified && att.dateModified > attachmentModified) {
            attachmentModified = att.dateModified;
          }
        } catch (e) {
          // Skip failed attachments
        }
      }
    }
    return { itemModified, attachmentModified };
  }

  /**
   * Get all items with content (regular items with attachments)
   */
  private async getItemsWithContent(): Promise<any[]> {
    try {
      // Get all regular items
      const search = new Zotero.Search();
      search.libraryID = Zotero.Libraries.userLibraryID;
      search.addCondition('itemType', 'isNot', 'attachment');
      search.addCondition('itemType', 'isNot', 'note');
      search.addCondition('itemType', 'isNot', 'annotation');

      const ids = await search.search();
      return Zotero.Items.getAsync(ids);
    } catch (error) {
      ztoolkit.log(`[SemanticSearch] Error getting items: ${error}`, 'warn');
      return [];
    }
  }

  /** Count standalone attachments or notes shown at the library's top level. */
  private async getStandaloneItemCount(itemType: 'attachment' | 'note'): Promise<number> {
    const search = new Zotero.Search();
    search.libraryID = Zotero.Libraries.userLibraryID;
    search.addCondition('itemType', 'is', itemType);
    const ids = await search.search();
    if (!ids.length) return 0;
    const items = await Zotero.Items.getAsync(ids);
    return (items || []).filter((item: any) => item && !item.parentItemID && !item.deleted).length;
  }

  /**
   * Hash content for change detection
   */
  private hashContent(content: string): string {
    // Simple hash using Zotero's utility
    try {
      return Zotero.Utilities.Internal.md5(content);
    } catch {
      // Fallback: simple hash
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString(16);
    }
  }

  /**
   * Destroy the service
   */
  destroy(): void {
    this.embeddingService.destroy();
    this.initialized = false;
    this.initPromise = null;
    ztoolkit.log('[SemanticSearch] Service destroyed');
  }
}

// Singleton instance
let semanticSearchInstance: SemanticSearchService | null = null;

export function getSemanticSearchService(): SemanticSearchService {
  if (!semanticSearchInstance) {
    ztoolkit.log(`[SemanticSearch] getSemanticSearchService() creating new singleton instance`);
    semanticSearchInstance = new SemanticSearchService();
  } else {
    ztoolkit.log(`[SemanticSearch] getSemanticSearchService() returning existing instance`);
  }
  return semanticSearchInstance;
}

/**
 * Reset the singleton instance (for shutdown cleanup)
 */
export function resetSemanticSearchService(): void {
  if (semanticSearchInstance) {
    semanticSearchInstance.abortIndex();
    semanticSearchInstance.destroy();
    semanticSearchInstance = null;
    ztoolkit.log('[SemanticSearch] Singleton instance reset');
  }
}
