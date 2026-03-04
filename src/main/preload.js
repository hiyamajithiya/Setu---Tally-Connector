const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('setu', {
  // Configuration
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Authentication
  login: (credentials) => ipcRenderer.invoke('login', credentials),
  logout: () => ipcRenderer.invoke('logout'),

  // Tally operations
  checkTallyConnection: () => ipcRenderer.invoke('check-tally-connection'),
  getTallyLedgers: () => ipcRenderer.invoke('get-tally-ledgers'),

  // Tally Sync - Ledger Mapping
  fetchLedgers: () => ipcRenderer.invoke('fetch-ledgers'),
  getLedgerMappings: () => ipcRenderer.invoke('get-ledger-mappings'),
  saveLedgerMappings: (mappings) => ipcRenderer.invoke('save-ledger-mappings', mappings),

  // Tally Sync - Sync Invoices
  syncInvoices: (params) => ipcRenderer.invoke('sync-invoices', params),
  fetchRecentVoucherNumbers: () => ipcRenderer.invoke('fetch-recent-voucher-numbers'),

  // Tally Sync - Manual Sync with Preview
  getManualSyncPreview: (params) => ipcRenderer.invoke('get-manual-sync-preview', params),
  executeManualSync: (params) => ipcRenderer.invoke('execute-manual-sync', params),

  // Tally Sync - Import from Tally
  fetchParties: () => ipcRenderer.invoke('fetch-parties'),
  fetchStockItems: () => ipcRenderer.invoke('fetch-stock-items'),
  fetchServiceLedgers: () => ipcRenderer.invoke('fetch-service-ledgers'),
  previewImportClients: (parties) => ipcRenderer.invoke('preview-import-clients', parties),
  previewImportProducts: (items) => ipcRenderer.invoke('preview-import-products', items),
  previewImportServices: (items) => ipcRenderer.invoke('preview-import-services', items),
  importClients: (parties) => ipcRenderer.invoke('import-clients', parties),
  importProducts: (items) => ipcRenderer.invoke('import-products', items),
  importServices: (items) => ipcRenderer.invoke('import-services', items),

  // Tally Sync - Company Master Import
  fetchCompanyDetails: () => ipcRenderer.invoke('fetch-company-details'),
  syncCompanyToNexInvo: (data) => ipcRenderer.invoke('sync-company-to-nexinvo', data),

  // Tally Sync - Complete Books Import (Account Groups, Ledgers with Balances, All Vouchers)
  fetchAccountGroups: () => ipcRenderer.invoke('fetch-account-groups'),
  fetchLedgersWithBalances: () => ipcRenderer.invoke('fetch-ledgers-with-balances'),
  fetchAllVouchers: (params) => ipcRenderer.invoke('fetch-all-vouchers', params),
  importAccountGroups: (groups) => ipcRenderer.invoke('import-account-groups', groups),
  importLedgerAccounts: (ledgers) => ipcRenderer.invoke('import-ledger-accounts', ledgers),
  importOpeningBalances: (balances) => ipcRenderer.invoke('import-opening-balances', balances),
  previewImportVouchers: (params) => ipcRenderer.invoke('preview-import-vouchers', params),
  importVouchers: (params) => ipcRenderer.invoke('import-vouchers', params),

  // Tally Sync - Real-Time Sync
  performRealtimeSync: () => ipcRenderer.invoke('perform-realtime-sync'),

  // Auto Sync Config (sync mode + voucher type preferences)
  saveAutoSyncConfig: (config) => ipcRenderer.invoke('save-auto-sync-config', config),
  getAutoSyncConfig: () => ipcRenderer.invoke('get-auto-sync-config'),

  // Queue management
  getQueueStatus: () => ipcRenderer.invoke('get-queue-status'),
  clearQueue: () => ipcRenderer.invoke('clear-queue'),

  // Status
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),
  getLogs: () => ipcRenderer.invoke('get-logs'),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // Event listeners
  onServerStatus: (callback) => {
    ipcRenderer.on('server-status', (event, data) => callback(data));
  },
  onTallyStatus: (callback) => {
    ipcRenderer.on('tally-status', (event, data) => callback(data));
  },
  onSyncStarted: (callback) => {
    ipcRenderer.on('sync-started', (event, data) => callback(data));
  },
  onSyncCompleted: (callback) => {
    ipcRenderer.on('sync-completed', (event, data) => callback(data));
  },
  onSyncQueued: (callback) => {
    ipcRenderer.on('sync-queued', (event, data) => callback(data));
  },
  onSyncError: (callback) => {
    ipcRenderer.on('sync-error', (event, data) => callback(data));
  },
  onInvoiceSynced: (callback) => {
    ipcRenderer.on('invoice-synced', (event, data) => callback(data));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on('error', (event, data) => callback(data));
  },

  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});
