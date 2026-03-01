const logger = require('../main/logger');

class QueueManager {
  constructor(store, tallyConnector) {
    this.store = store;
    this.tallyConnector = tallyConnector;
    this.isProcessing = false;
    this.processInterval = null;

    // Initialize queue from store
    this.queue = this.store.get('syncQueue') || [];
  }

  /**
   * Add item to the offline queue
   */
  addToQueue(item) {
    const queueItem = {
      id: this.generateId(),
      ...item,
      addedAt: Date.now(),
      attempts: 0,
      maxAttempts: 3,
      status: 'pending'
    };

    this.queue.push(queueItem);
    this.saveQueue();

    logger.info(`Added item to queue: ${queueItem.id}`);
    return queueItem.id;
  }

  /**
   * Remove item from queue
   */
  removeFromQueue(id) {
    this.queue = this.queue.filter(item => item.id !== id);
    this.saveQueue();
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      total: this.queue.length,
      pending: this.queue.filter(i => i.status === 'pending').length,
      processing: this.queue.filter(i => i.status === 'processing').length,
      failed: this.queue.filter(i => i.status === 'failed').length,
      isProcessing: this.isProcessing,
      items: this.queue.map(item => ({
        id: item.id,
        type: item.type,
        status: item.status,
        attempts: item.attempts,
        addedAt: item.addedAt,
        lastAttempt: item.lastAttempt,
        error: item.error
      }))
    };
  }

  /**
   * Clear all items from queue
   */
  clearQueue() {
    this.queue = [];
    this.saveQueue();
    logger.info('Queue cleared');
  }

  /**
   * Clear only failed items
   */
  clearFailed() {
    this.queue = this.queue.filter(item => item.status !== 'failed');
    this.saveQueue();
    logger.info('Failed items cleared from queue');
  }

  /**
   * Retry failed items
   */
  retryFailed() {
    this.queue.forEach(item => {
      if (item.status === 'failed') {
        item.status = 'pending';
        item.attempts = 0;
        item.error = null;
      }
    });
    this.saveQueue();
    this.processQueue();
  }

  /**
   * Save queue to persistent storage
   */
  saveQueue() {
    this.store.set('syncQueue', this.queue);
  }

  /**
   * Start periodic queue processing
   */
  startProcessing() {
    // Process immediately if there are items
    if (this.queue.length > 0) {
      this.processQueue();
    }

    // Check queue every 5 minutes
    this.processInterval = setInterval(() => {
      if (this.queue.some(i => i.status === 'pending')) {
        this.processQueue();
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Stop queue processing
   */
  stopProcessing() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
  }

  /**
   * Process pending items in queue
   */
  async processQueue() {
    if (this.isProcessing) {
      logger.debug('Queue already being processed');
      return;
    }

    // Check if Tally is connected first
    try {
      const tallyStatus = await this.tallyConnector.checkConnection();
      if (!tallyStatus.connected) {
        logger.info('Tally not connected, skipping queue processing');
        return;
      }
    } catch (error) {
      logger.warn('Cannot check Tally connection:', error.message);
      return;
    }

    this.isProcessing = true;
    logger.info(`Processing queue (${this.queue.filter(i => i.status === 'pending').length} pending items)`);

    try {
      for (const item of this.queue) {
        if (item.status !== 'pending') continue;

        item.status = 'processing';
        item.lastAttempt = Date.now();
        item.attempts++;
        this.saveQueue();

        try {
          await this.processItem(item);

          // Success - remove from queue
          this.removeFromQueue(item.id);
          logger.info(`Queue item ${item.id} processed successfully`);

        } catch (error) {
          logger.error(`Failed to process queue item ${item.id}:`, error.message);

          item.error = error.message;

          if (item.attempts >= item.maxAttempts) {
            item.status = 'failed';
            logger.warn(`Queue item ${item.id} failed after ${item.attempts} attempts`);
          } else {
            item.status = 'pending';
          }

          this.saveQueue();
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single queue item
   */
  async processItem(item) {
    switch (item.type) {
      case 'SYNC_INVOICES':
        await this.processSyncInvoices(item.data);
        break;

      case 'CREATE_LEDGER':
        await this.tallyConnector.createPartyLedger(item.data.client, item.data.mapping);
        break;

      case 'SYNC_SINGLE_INVOICE':
        await this.tallyConnector.syncInvoice(item.data.invoice, item.data.mapping);
        break;

      default:
        throw new Error(`Unknown queue item type: ${item.type}`);
    }
  }

  /**
   * Process batch invoice sync
   */
  async processSyncInvoices(data) {
    const results = {
      success: [],
      failed: []
    };

    for (const invoice of data.invoices) {
      try {
        await this.tallyConnector.syncInvoice(invoice, data.mapping);
        results.success.push(invoice.id);
      } catch (error) {
        results.failed.push({
          id: invoice.id,
          error: error.message
        });
      }
    }

    // If all failed, throw error to mark item as failed
    if (results.success.length === 0 && results.failed.length > 0) {
      throw new Error(`All ${results.failed.length} invoices failed to sync`);
    }

    return results;
  }

  /**
   * Generate unique ID
   */
  generateId() {
    return `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = QueueManager;
