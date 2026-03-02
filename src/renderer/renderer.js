// Setu Renderer Process
document.addEventListener('DOMContentLoaded', () => {
  // Set current year in footer
  document.querySelectorAll('.current-year').forEach(el => {
    el.textContent = new Date().getFullYear();
  });
  // DOM Elements
  const loginScreen = document.getElementById('login-screen');
  const dashboardScreen = document.getElementById('dashboard-screen');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const loginBtn = document.getElementById('login-btn');

  // Status elements
  const serverBadge = document.getElementById('server-badge');
  const tallyBadge = document.getElementById('tally-badge');
  const serverStatusIcon = document.getElementById('server-status-icon');
  const tallyStatusIcon = document.getElementById('tally-status-icon');
  const serverStatusText = document.getElementById('server-status-text');
  const tallyStatusText = document.getElementById('tally-status-text');
  const tallyCompany = document.getElementById('tally-company');
  const lastSyncTime = document.getElementById('last-sync-time');
  const queueCount = document.getElementById('queue-count');

  // Sync progress elements
  const syncProgress = document.getElementById('sync-progress');
  const syncProgressBar = document.getElementById('sync-progress-bar');
  const syncProgressText = document.getElementById('sync-progress-text');
  const syncStatusMessage = document.getElementById('sync-status-message');

  // Tabs
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  // Tally Sync state
  let tallyLedgers = [];
  let tallyParties = [];
  let tallyStockItems = [];
  let stockItemsAreServices = false; // true when items came from Sales Accounts ledgers
  let selectedParties = new Set();
  let selectedStockItems = new Set();

  // Real-Time Sync state
  let autoSyncEnabled = false;
  let autoSyncInterval = null;
  let autoSyncIntervalMinutes = 15;
  let nextSyncTime = null;
  let countdownInterval = null;
  let syncsTodayCount = 0;
  let invoicesSyncedToday = 0;
  let syncLogEntries = [];

  // Initialize - ensure badges start as disconnected
  updateServerStatus(false);
  updateTallyStatus(false, '', '');

  init();

  async function init() {
    try {
      const config = await window.setu.getConfig();

      // Check if already logged in AND has valid token
      if (config.serverUrl && config.authToken) {
        // Get actual connection status
        const status = await window.setu.getConnectionStatus();

        showDashboard();
        // If we have valid credentials, consider server as connected
        // (the auth token is valid, so we're connected to NexInvo)
        updateServerStatus(true);

        // Populate user email from saved config
        if (config.userEmail) {
          const userEmailEl = document.getElementById('user-email');
          const settingsUserEmail = document.getElementById('settings-user-email');
          if (userEmailEl) userEmailEl.textContent = config.userEmail;
          if (settingsUserEmail) settingsUserEmail.textContent = config.userEmail;
        }
        // Update Tally status from actual connection status
        if (status.tally !== undefined) {
          updateTallyStatus(status.tally);
        }

        // Check Tally connection
        checkTallyConnection();

        // Load initial data
        loadQueueStatus();

        // Load invoice series settings
        loadInvoiceSeriesSettings();

        // Update last sync time
        if (config.lastSync) {
          lastSyncTime.textContent = formatDate(config.lastSync);
        }
      } else {
        // No valid credentials - show login with disconnected status
        showLogin();
      }

      // Setup event listeners
      setupEventListeners();
      setupIPCListeners();

    } catch (error) {
      console.error('Init error:', error);
      showLogin();
    }
  }

  function setupEventListeners() {
    // Application dropdown - sync with hidden server-url field
    const appSelect = document.getElementById('app-select');
    const serverUrlInput = document.getElementById('server-url');
    const customUrlGroup = document.getElementById('custom-url-group');
    const customUrlInput = document.getElementById('custom-url');

    if (appSelect) {
      appSelect.addEventListener('change', () => {
        if (appSelect.value === 'custom') {
          // Show custom URL input
          customUrlGroup.classList.remove('hidden');
          customUrlInput.required = true;
          // Use custom URL value or empty
          serverUrlInput.value = customUrlInput.value || '';
        } else {
          // Hide custom URL input and use selected value
          customUrlGroup.classList.add('hidden');
          customUrlInput.required = false;
          serverUrlInput.value = appSelect.value;
        }
      });
    }

    // Update hidden server-url when custom URL changes
    if (customUrlInput) {
      customUrlInput.addEventListener('input', () => {
        if (appSelect.value === 'custom') {
          serverUrlInput.value = customUrlInput.value;
        }
      });
    }

    // Login form
    loginForm.addEventListener('submit', handleLogin);

    // Sidebar navigation
    document.querySelectorAll('.nav-item').forEach(navItem => {
      navItem.addEventListener('click', () => {
        const tabId = navItem.dataset.tab;
        if (tabId) {
          switchTab(tabId);
        }
      });
    });

    // Old tabs (if any still exist)
    tabs.forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Check Tally button
    document.getElementById('check-tally-btn')?.addEventListener('click', checkTallyConnection);

    // Tally settings form (old - may not exist)
    document.getElementById('tally-settings-form')?.addEventListener('submit', saveTallySettings);

    // Test Tally connection button (new settings page)
    document.getElementById('test-tally-btn')?.addEventListener('click', checkTallyConnection);

    // Minimize to tray checkbox (old ID)
    document.getElementById('minimize-tray')?.addEventListener('change', async (e) => {
      await window.setu.saveConfig({ minimizeToTray: e.target.checked });
    });

    // Minimize to tray checkbox (new ID)
    document.getElementById('minimize-to-tray')?.addEventListener('change', async (e) => {
      await window.setu.saveConfig({ minimizeToTray: e.target.checked });
    });

    // Auto-start checkbox
    document.getElementById('auto-start')?.addEventListener('change', async (e) => {
      await window.setu.saveConfig({ autoStart: e.target.checked });
    });

    // Logout buttons (multiple locations now)
    document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
    document.getElementById('sidebar-logout-btn')?.addEventListener('click', handleLogout);

    // Quick action buttons
    document.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'sync-invoices' || action === 'manual-sync') {
          switchTab('manual-sync');
        } else if (action === 'import-clients') {
          switchTab('import-tally');
          // Select clients tab in import
          document.querySelectorAll('.import-type-card').forEach(c => c.classList.remove('active'));
          document.querySelector('.import-type-card[data-import-tab="clients"]')?.classList.add('active');
          switchImportTab('clients');
        } else if (action === 'import-products') {
          switchTab('import-tally');
          // Select products tab in import
          document.querySelectorAll('.import-type-card').forEach(c => c.classList.remove('active'));
          document.querySelector('.import-type-card[data-import-tab="products"]')?.classList.add('active');
          switchImportTab('products');
        } else if (action === 'ledger-mapping') {
          switchTab('ledger-mapping');
        }
      });
    });

    // Check updates button
    document.getElementById('check-updates-btn').addEventListener('click', () => {
      window.setu.checkForUpdates();
      document.getElementById('update-status').textContent = 'Checking for updates...';
    });

    // Queue buttons - only add if elements exist
    const refreshQueueBtn = document.getElementById('refresh-queue-btn');
    const clearQueueBtn = document.getElementById('clear-queue-btn');
    if (refreshQueueBtn) refreshQueueBtn.addEventListener('click', loadQueueStatus);
    if (clearQueueBtn) clearQueueBtn.addEventListener('click', clearQueue);

    // Logs refresh
    document.getElementById('refresh-logs-btn')?.addEventListener('click', loadLogs);

    // Log filter buttons
    document.querySelectorAll('.log-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filterLogs(btn.dataset.level);
      });
    });

    // === Tally Sync Event Listeners ===

    // Ledger Mapping
    document.getElementById('fetch-ledgers-btn')?.addEventListener('click', fetchLedgersFromTally);
    document.getElementById('ledger-mapping-form')?.addEventListener('submit', saveLedgerMappings);

    // Invoice Series Settings
    document.getElementById('invoice-series-form')?.addEventListener('submit', saveInvoiceSeriesSettings);

    // Sync Invoices (old form)
    document.getElementById('sync-invoices-form')?.addEventListener('submit', handleSyncInvoices);

    // Manual Sync with Preview
    setupManualSyncListeners();

    // Import from Tally - Tab switching (old tabs)
    document.querySelectorAll('.import-tab').forEach(tab => {
      tab.addEventListener('click', () => switchImportTab(tab.dataset.importTab));
    });

    // Import from Tally - Type card switching (new design)
    document.querySelectorAll('.import-type-card').forEach(card => {
      card.addEventListener('click', () => {
        const tabId = card.dataset.importTab;
        // Update card active states
        document.querySelectorAll('.import-type-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        // Switch content
        switchImportTab(tabId);
        // Update step indicator
        updateImportStep(1);
      });
    });

    // Import - Fetch buttons
    document.getElementById('fetch-parties-btn')?.addEventListener('click', fetchPartiesFromTally);
    document.getElementById('fetch-stock-btn')?.addEventListener('click', fetchStockFromTally);
    document.getElementById('fetch-company-btn')?.addEventListener('click', fetchCompanyFromTally);
    document.getElementById('sync-company-btn')?.addEventListener('click', syncCompanyToNexInvo);

    // Auto-derive state code from GSTIN
    document.getElementById('company-gstin')?.addEventListener('input', (e) => {
      const gstin = e.target.value.trim();
      if (gstin.length >= 2) {
        document.getElementById('company-state-code').value = gstin.substring(0, 2);
      }
    });

    // Import - Select all checkboxes
    document.getElementById('select-all-parties')?.addEventListener('change', (e) => {
      toggleSelectAll('parties', e.target.checked);
    });
    document.getElementById('select-all-stock')?.addEventListener('change', (e) => {
      toggleSelectAll('stock', e.target.checked);
    });

    // Import - Import buttons
    document.getElementById('import-clients-btn')?.addEventListener('click', previewImportClients);
    document.getElementById('import-products-btn')?.addEventListener('click', previewImportProducts);

    // Real-Time Sync
    setupRealtimeSyncListeners();
  }

  // ==========================================
  // REAL-TIME SYNC EVENT LISTENERS
  // ==========================================

  function setupRealtimeSyncListeners() {
    // Interval selection
    document.querySelectorAll('input[name="sync-interval"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const customInput = document.getElementById('custom-interval-input');
        if (e.target.value === 'custom') {
          customInput?.classList.remove('hidden');
        } else {
          customInput?.classList.add('hidden');
          autoSyncIntervalMinutes = parseInt(e.target.value);
        }
      });
    });

    // Custom interval input (support both old and new IDs)
    const customIntervalInput = document.getElementById('custom-interval-value') || document.getElementById('custom-minutes');
    customIntervalInput?.addEventListener('change', (e) => {
      const value = parseInt(e.target.value);
      if (value >= 1 && value <= 1440) {
        autoSyncIntervalMinutes = value;
      }
    });

    // Start/Stop Auto-Sync buttons
    document.getElementById('start-auto-sync-btn')?.addEventListener('click', startAutoSync);
    document.getElementById('stop-auto-sync-btn')?.addEventListener('click', stopAutoSync);
  }

  function setupIPCListeners() {
    // Server status
    window.setu.onServerStatus((data) => {
      updateServerStatus(data.connected);
    });

    // Tally status
    window.setu.onTallyStatus((data) => {
      updateTallyStatus(data.connected, data.companyName, data.tallyVersion);
    });

    // Sync events
    window.setu.onSyncStarted((data) => {
      showSyncProgress(true);
      syncStatusMessage.textContent = `Syncing ${data.invoices?.length || 0} invoices...`;
    });

    window.setu.onInvoiceSynced((data) => {
      syncStatusMessage.textContent = `Synced: ${data.invoice}`;
    });

    window.setu.onSyncCompleted((data) => {
      showSyncProgress(false);
      const successCount = data.success?.length || 0;
      const failedCount = data.failed?.length || 0;
      showToast(`Sync completed: ${successCount} success, ${failedCount} failed`, failedCount > 0 ? 'error' : 'success');
      lastSyncTime.textContent = formatDate(new Date().toISOString());
    });

    window.setu.onSyncQueued((data) => {
      showSyncProgress(false);
      showToast('Tally offline. Request added to queue.', 'info');
      loadQueueStatus();
    });

    window.setu.onSyncError((data) => {
      showSyncProgress(false);
      showToast(`Sync error: ${data.message}`, 'error');
    });

    // Update status
    window.setu.onUpdateStatus((data) => {
      const updateStatus = document.getElementById('update-status');
      switch (data.status) {
        case 'checking':
          updateStatus.textContent = 'Checking for updates...';
          break;
        case 'available':
          updateStatus.textContent = `Update available: v${data.info.version}`;
          break;
        case 'not-available':
          updateStatus.textContent = 'You have the latest version.';
          break;
        case 'downloading':
          updateStatus.textContent = `Downloading: ${Math.round(data.progress.percent)}%`;
          break;
        case 'downloaded':
          updateStatus.textContent = 'Update downloaded. Restart to install.';
          break;
        case 'error':
          updateStatus.textContent = `Update error: ${data.error}`;
          break;
      }
    });

    // Errors
    window.setu.onError((data) => {
      showToast(`Error: ${data.message}`, 'error');
    });
  }

  async function handleLogin(e) {
    e.preventDefault();

    const serverUrl = document.getElementById('server-url').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    // Show loading
    loginBtn.disabled = true;
    loginBtn.querySelector('.btn-text').textContent = 'Connecting...';
    loginBtn.querySelector('.btn-loader').classList.remove('hidden');
    loginError.classList.add('hidden');

    try {
      const result = await window.setu.login({ serverUrl, email, password });

      if (result.success) {
        showDashboard();
        // Update server status to connected immediately after successful login
        updateServerStatus(true);
        // Update email in multiple places
        const userEmailEl = document.getElementById('user-email');
        const settingsUserEmail = document.getElementById('settings-user-email');
        if (userEmailEl) userEmailEl.textContent = email;
        if (settingsUserEmail) settingsUserEmail.textContent = email;
        showToast('Connected to NexInvo', 'success');

        // Check Tally connection
        checkTallyConnection();
      } else {
        loginError.textContent = result.error || 'Login failed';
        loginError.classList.remove('hidden');
      }
    } catch (error) {
      loginError.textContent = error.message || 'Connection failed';
      loginError.classList.remove('hidden');
    } finally {
      loginBtn.disabled = false;
      loginBtn.querySelector('.btn-text').textContent = 'Connect';
      loginBtn.querySelector('.btn-loader').classList.add('hidden');
    }
  }

  async function handleLogout() {
    await window.setu.logout();
    showLogin();
    showToast('Logged out', 'info');
  }

  async function checkTallyConnection() {
    const btn = document.getElementById('check-tally-btn');
    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
      const result = await window.setu.checkTallyConnection();
      updateTallyStatus(result.connected, result.companyName, result.tallyVersion);

      if (result.connected) {
        showToast('Tally connected', 'success');
      } else {
        showToast(`Tally not connected: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      updateTallyStatus(false);
      showToast(`Error: ${error.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check Tally Connection';
    }
  }

  async function saveTallySettings(e) {
    e.preventDefault();

    const host = document.getElementById('tally-host').value.trim();
    const port = parseInt(document.getElementById('tally-port').value);

    await window.setu.saveConfig({ tallyHost: host, tallyPort: port });
    showToast('Settings saved', 'success');
  }

  async function loadQueueStatus() {
    try {
      const status = await window.setu.getQueueStatus();
      queueCount.textContent = status.total;

      const queueEmpty = document.getElementById('queue-empty');
      const queueList = document.getElementById('queue-list');

      if (status.total === 0) {
        queueEmpty.classList.remove('hidden');
        queueList.classList.add('hidden');
      } else {
        queueEmpty.classList.add('hidden');
        queueList.classList.remove('hidden');

        queueList.innerHTML = status.items.map(item => `
          <div class="queue-item">
            <div class="queue-item-info">
              <span class="queue-item-type">${item.type.replace('_', ' ')}</span>
              <span class="queue-item-time">${formatDate(item.addedAt)} - ${item.attempts} attempts</span>
            </div>
            <span class="queue-item-status ${item.status}">${item.status}</span>
          </div>
        `).join('');
      }
    } catch (error) {
      console.error('Failed to load queue status:', error);
    }
  }

  async function clearQueue() {
    if (confirm('Are you sure you want to clear all queue items?')) {
      await window.setu.clearQueue();
      loadQueueStatus();
      showToast('Queue cleared', 'success');
    }
  }

  let allLogs = []; // Store logs for filtering

  async function loadLogs() {
    try {
      const logs = await window.setu.getLogs();
      allLogs = logs;
      const container = document.getElementById('logs-content');

      if (!container) return;

      // Reset filter to "All"
      document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
      document.querySelector('.log-filter[data-level="all"]')?.classList.add('active');

      renderLogs(logs);
    } catch (error) {
      console.error('Failed to load logs:', error);
    }
  }

  function filterLogs(level) {
    if (level === 'all') {
      renderLogs(allLogs);
    } else {
      renderLogs(allLogs.filter(log => log.level === level));
    }
  }

  function renderLogs(logs) {
    const container = document.getElementById('logs-content');
    if (!container) return;

    // Update count
    const countEl = document.getElementById('log-count');
    if (countEl) countEl.textContent = `${logs.length} entries`;

    if (logs.length === 0) {
      container.innerHTML = '<div class="logs-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>No logs to display</p></div>';
      return;
    }

    container.innerHTML = logs.map(log => {
      const levelIcon = log.level === 'error' ? '&#x2716;' : log.level === 'warn' ? '&#x26A0;' : '&#x2139;';
      return `
        <div class="log-entry ${log.level}">
          <span class="log-icon">${levelIcon}</span>
          <span class="log-time">${formatTime(log.timestamp)}</span>
          <span class="log-level-badge ${log.level}">${log.level.toUpperCase()}</span>
          <span class="log-message">${escapeHtml(log.message)}</span>
        </div>
      `;
    }).join('');

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    dashboardScreen.classList.add('hidden');
    // Reset status badges to disconnected when showing login screen
    updateServerStatus(false);
    updateTallyStatus(false, '', '');
  }

  function showDashboard() {
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
  }

  function switchTab(tabId) {
    // Update sidebar nav items
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-tab="${tabId}"]`)?.classList.add('active');

    // Update old tabs if they exist
    tabs.forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabId}"]`)?.classList.add('active');

    // Hide all tab contents and show selected one
    tabContents.forEach(c => c.classList.add('hidden'));
    const tabContent = document.getElementById(`${tabId}-tab`);
    if (tabContent) {
      tabContent.classList.remove('hidden');
    }

    // Update page title in topbar
    const pageTitles = {
      'status': 'Dashboard',
      'ledger-mapping': 'Ledger Mapping',
      'import-tally': 'Import from Tally',
      'manual-sync': 'Manual Sync',
      'auto-sync': 'Auto Sync',
      'settings': 'Settings',
      'logs': 'Activity Logs'
    };
    const pageTitle = document.getElementById('page-title');
    if (pageTitle && pageTitles[tabId]) {
      pageTitle.textContent = pageTitles[tabId];
    }

    // Load data for specific tabs
    if (tabId === 'queue') {
      loadQueueStatus();
    } else if (tabId === 'logs') {
      loadLogs();
    }
  }

  function updateConnectionStatus(status) {
    updateServerStatus(status.server);
    updateTallyStatus(status.tally);
  }

  function updateServerStatus(connected) {
    // Update topbar badge
    if (serverBadge) {
      serverBadge.className = connected ? 'status-badge connected' : 'status-badge disconnected';
    }

    // Update dashboard connection item
    const serverConnection = document.getElementById('server-connection');
    if (serverConnection) {
      const indicator = serverConnection.querySelector('.conn-indicator');
      if (indicator) {
        indicator.className = connected ? 'conn-indicator connected' : 'conn-indicator disconnected';
      }
    }

    // Update status text
    if (serverStatusText) {
      serverStatusText.textContent = connected ? 'Connected' : 'Disconnected';
    }

    // Update sidebar status
    const sidebarServerStatus = document.getElementById('sidebar-server-status');
    if (sidebarServerStatus) {
      const dot = sidebarServerStatus.querySelector('.status-dot');
      if (dot) {
        dot.className = connected ? 'status-dot connected' : 'status-dot disconnected';
      }
    }
  }

  function updateTallyStatus(connected, companyName = '', tallyVersion = '') {
    // Update topbar badge
    if (tallyBadge) {
      tallyBadge.className = connected ? 'status-badge connected' : 'status-badge disconnected';
    }

    // Update dashboard connection item
    const tallyConnection = document.getElementById('tally-connection');
    if (tallyConnection) {
      const indicator = tallyConnection.querySelector('.conn-indicator');
      if (indicator) {
        indicator.className = connected ? 'conn-indicator connected' : 'conn-indicator disconnected';
      }
    }

    // Update status text
    if (tallyStatusText) {
      tallyStatusText.textContent = connected ? 'Connected' : 'Disconnected';
    }

    // Update company name
    if (tallyCompany) {
      tallyCompany.textContent = companyName || '';
    }

    // Update sidebar status
    const sidebarTallyStatus = document.getElementById('sidebar-tally-status');
    if (sidebarTallyStatus) {
      const dot = sidebarTallyStatus.querySelector('.status-dot');
      if (dot) {
        dot.className = connected ? 'status-dot connected' : 'status-dot disconnected';
      }
    }
  }

  function showSyncProgress(show) {
    if (show) {
      syncProgress.classList.remove('hidden');
      tallyBadge.className = 'badge badge-syncing';
    } else {
      syncProgress.classList.add('hidden');
    }
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleString();
  }

  function formatTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleTimeString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ==========================================
  // TALLY SYNC FUNCTIONS
  // ==========================================

  // Switch import sub-tabs (Clients / Products)
  function switchImportTab(tabId) {
    document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.import-content').forEach(c => c.classList.add('hidden'));

    document.querySelector(`.import-tab[data-import-tab="${tabId}"]`)?.classList.add('active');
    document.getElementById(`import-${tabId}-content`)?.classList.remove('hidden');
  }

  // Update step indicator for import process
  function updateImportStep(step) {
    document.querySelectorAll('.import-steps .step').forEach((s, idx) => {
      s.classList.remove('active', 'completed');
      if (idx + 1 < step) {
        s.classList.add('completed');
      } else if (idx + 1 === step) {
        s.classList.add('active');
      }
    });
  }

  // Toggle select all checkboxes
  function toggleSelectAll(type, checked) {
    console.log(`toggleSelectAll called: type=${type}, checked=${checked}`);
    if (type === 'parties') {
      if (checked) {
        tallyParties.forEach((_, idx) => selectedParties.add(idx));
        console.log(`Selected ${selectedParties.size} parties`);
      } else {
        selectedParties.clear();
        console.log('Cleared all party selections');
      }
      renderPartiesList();
      // Update the select-all checkbox state
      const selectAllCheckbox = document.getElementById('select-all-parties');
      if (selectAllCheckbox) selectAllCheckbox.checked = checked;
    } else if (type === 'stock') {
      if (checked) {
        tallyStockItems.forEach((_, idx) => selectedStockItems.add(idx));
        console.log(`Selected ${selectedStockItems.size} stock items`);
      } else {
        selectedStockItems.clear();
        console.log('Cleared all stock selections');
      }
      renderStockList();
      // Update the select-all checkbox state
      const selectAllCheckbox = document.getElementById('select-all-stock');
      if (selectAllCheckbox) selectAllCheckbox.checked = checked;
    } else if (type === 'toTally') {
      if (checked) {
        twoWayPreviewData.toTally.forEach((_, idx) => selectedToTally.add(idx));
      } else {
        selectedToTally.clear();
      }
      renderTwoWayLists();
    } else if (type === 'toNexinvo') {
      if (checked) {
        twoWayPreviewData.toNexinvo.forEach((_, idx) => selectedToNexinvo.add(idx));
      } else {
        selectedToNexinvo.clear();
      }
      renderTwoWayLists();
    }
  }

  // ==========================================
  // LEDGER MAPPING
  // ==========================================

  async function fetchLedgersFromTally() {
    const btn = document.getElementById('fetch-ledgers-btn');
    // Support both old and new IDs
    const loading = document.getElementById('ledger-mapping-loading') || document.getElementById('ledger-loading');
    const form = document.getElementById('ledger-mapping-form');

    btn.disabled = true;
    btn.textContent = 'Fetching...';
    if (loading) loading.classList.remove('hidden');

    try {
      const result = await window.setu.fetchLedgers();

      if (result.success && result.ledgers) {
        tallyLedgers = result.ledgers;
        populateLedgerDropdowns(result.ledgers);
        form.classList.remove('hidden');
        showToast(`Fetched ${result.ledgers.length} ledgers`, 'success');
      } else {
        showToast(result.error || 'Failed to fetch ledgers', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Fetch Ledgers from Tally';
      if (loading) loading.classList.add('hidden');
    }
  }

  async function populateLedgerDropdowns(ledgers) {
    const selects = ['sales-ledger', 'cgst-ledger', 'sgst-ledger', 'igst-ledger', 'roundoff-ledger', 'discount-ledger'];

    // Mapping from select ID to saved config key
    const selectToConfigKey = {
      'sales-ledger': 'salesLedger',
      'cgst-ledger': 'cgstLedger',
      'sgst-ledger': 'sgstLedger',
      'igst-ledger': 'igstLedger',
      'roundoff-ledger': 'roundOffLedger',
      'discount-ledger': 'discountLedger'
    };

    // Auto-mapping patterns for each ledger type (used only if no saved mapping)
    const autoMapPatterns = {
      'sales-ledger': ['sales', 'sale account', 'sales account', 'sales a/c', 'revenue', 'professional services', 'service charges', 'consulting'],
      'cgst-ledger': ['cgst', 'central gst', 'output cgst', 'cgst output', 'cgst payable'],
      'sgst-ledger': ['sgst', 'state gst', 'output sgst', 'sgst output', 'sgst payable'],
      'igst-ledger': ['igst', 'integrated gst', 'output igst', 'igst output', 'igst payable'],
      'roundoff-ledger': ['round off', 'roundoff', 'rounding off', 'round-off'],
      'discount-ledger': ['discount', 'discount allowed', 'sales discount', 'trade discount']
    };

    // Parent group fallback: if pattern match fails, match by parent group
    const autoMapByGroup = {
      'sales-ledger': ['sales accounts', 'sales account'],
      'cgst-ledger': ['duties & taxes', 'duties and taxes'],
      'sgst-ledger': ['duties & taxes', 'duties and taxes'],
      'igst-ledger': ['duties & taxes', 'duties and taxes'],
      'roundoff-ledger': ['indirect expenses', 'indirect incomes'],
      'discount-ledger': ['indirect expenses']
    };

    // Try to load saved mappings
    let savedMappings = null;
    try {
      const config = await window.setu.getConfig();
      savedMappings = config.ledgerMappings;
    } catch (e) {
      console.log('No saved ledger mappings found');
    }

    // Populate dropdowns
    selects.forEach(selectId => {
      const select = document.getElementById(selectId);
      if (!select) return;

      // For the sales ledger, group Sales Accounts at top
      select.innerHTML = '<option value="">Select Ledger</option>';

      if (selectId === 'sales-ledger') {
        // Separate Sales Accounts ledgers from the rest
        const salesLedgers = ledgers.filter(l =>
          (l.group || l.parent || '').toLowerCase().includes('sales account')
        );
        const otherLedgers = ledgers.filter(l =>
          !(l.group || l.parent || '').toLowerCase().includes('sales account')
        );

        if (salesLedgers.length > 0) {
          const salesGroup = document.createElement('optgroup');
          salesGroup.label = `Sales Accounts (${salesLedgers.length} ledgers)`;
          salesLedgers.forEach(ledger => {
            const option = document.createElement('option');
            option.value = ledger.name;
            option.textContent = ledger.name;
            salesGroup.appendChild(option);
          });
          select.appendChild(salesGroup);
        }

        if (otherLedgers.length > 0) {
          const otherGroup = document.createElement('optgroup');
          otherGroup.label = 'Other Ledgers';
          otherLedgers.forEach(ledger => {
            const option = document.createElement('option');
            option.value = ledger.name;
            option.textContent = `${ledger.name} (${ledger.group || ledger.parent || 'N/A'})`;
            otherGroup.appendChild(option);
          });
          select.appendChild(otherGroup);
        }
      } else {
        ledgers.forEach(ledger => {
          const option = document.createElement('option');
          option.value = ledger.name;
          option.textContent = `${ledger.name} (${ledger.group || ledger.parent || 'N/A'})`;
          select.appendChild(option);
        });
      }

      // First priority: Use saved mapping if available
      const configKey = selectToConfigKey[selectId];
      if (savedMappings && savedMappings[configKey]) {
        // Check if the saved ledger exists in current ledger list
        const savedLedgerExists = ledgers.some(l => l.name === savedMappings[configKey]);
        if (savedLedgerExists) {
          select.value = savedMappings[configKey];
          return; // Skip auto-mapping for this select
        }
      }

      // Second priority: Auto-map based on name patterns
      let mapped = false;
      const patterns = autoMapPatterns[selectId] || [];
      for (const pattern of patterns) {
        const matchedLedger = ledgers.find(l =>
          l.name.toLowerCase().includes(pattern.toLowerCase()) ||
          l.name.toLowerCase() === pattern.toLowerCase()
        );
        if (matchedLedger) {
          select.value = matchedLedger.name;
          mapped = true;
          break;
        }
      }

      // Third priority: Auto-map by parent group (e.g. first ledger under "Sales Accounts")
      if (!mapped) {
        const groupPatterns = autoMapByGroup[selectId] || [];
        for (const groupPattern of groupPatterns) {
          const matchedLedger = ledgers.find(l =>
            (l.group || l.parent || '').toLowerCase() === groupPattern.toLowerCase()
          );
          if (matchedLedger) {
            select.value = matchedLedger.name;
            break;
          }
        }
      }
    });

    // Show appropriate message
    const mappedCount = selects.filter(id => document.getElementById(id)?.value).length;
    if (savedMappings) {
      showToast(`Loaded saved mappings. ${mappedCount} ledgers mapped.`, 'success');
    } else if (mappedCount > 0) {
      showToast(`Auto-mapped ${mappedCount} ledgers. Save to remember your selection.`, 'info');
    }
  }

  async function saveLedgerMappings(e) {
    e.preventDefault();

    const mappings = {
      salesLedger: document.getElementById('sales-ledger').value,
      cgstLedger: document.getElementById('cgst-ledger').value,
      sgstLedger: document.getElementById('sgst-ledger').value,
      igstLedger: document.getElementById('igst-ledger').value,
      roundOffLedger: document.getElementById('roundoff-ledger').value,
      discountLedger: document.getElementById('discount-ledger').value
    };

    try {
      // Save to backend
      const result = await window.setu.saveLedgerMappings(mappings);

      // Also save locally for quick access
      await window.setu.saveConfig({ ledgerMappings: mappings });

      if (result.success) {
        showToast('Ledger mappings saved successfully', 'success');
      } else {
        showToast(result.error || 'Failed to save mappings', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    }
  }

  // ==========================================
  // INVOICE NUMBER SERIES MAPPING
  // ==========================================

  async function loadInvoiceSeriesSettings() {
    try {
      // First load from local config for quick display
      const config = await window.setu.getConfig();
      const seriesSettings = config.invoiceSeriesSettings;

      if (seriesSettings) {
        // Set the radio button
        const modeRadio = document.querySelector(`input[name="invoice-number-mode"][value="${seriesSettings.invoiceNumberMode || 'keep'}"]`);
        if (modeRadio) modeRadio.checked = true;

        // Set the custom prefix
        const prefixInput = document.getElementById('tally-invoice-prefix');
        if (prefixInput) prefixInput.value = seriesSettings.tallyInvoicePrefix || '';

        // Set auto-detect checkbox
        const autoDetect = document.getElementById('auto-detect-series');
        if (autoDetect) autoDetect.checked = seriesSettings.autoDetectSeries !== false;
      }

      // Then fetch from backend to get detected prefix (async)
      const result = await window.setu.getLedgerMappings();
      if (result.success && result.mappings) {
        const mappings = result.mappings;

        // Update detected prefix from backend
        const detectedSpan = document.getElementById('detected-tally-prefix');
        if (detectedSpan) {
          if (mappings.detectedTallyPrefix) {
            detectedSpan.textContent = mappings.detectedTallyPrefix;
            detectedSpan.style.color = 'var(--success)';
          } else {
            // No prefix from backend — try detecting from Tally directly
            detectedSpan.textContent = 'Detecting from Tally...';
            detectedSpan.style.color = 'var(--gray-500)';
            detectPrefixFromTally(detectedSpan);
          }
        }

        // Also update the form fields from backend if not set locally
        if (!seriesSettings) {
          const modeRadio = document.querySelector(`input[name="invoice-number-mode"][value="${mappings.invoiceNumberMode || 'keep'}"]`);
          if (modeRadio) modeRadio.checked = true;

          const prefixInput = document.getElementById('tally-invoice-prefix');
          if (prefixInput) prefixInput.value = mappings.tallyInvoicePrefix || '';

          const autoDetect = document.getElementById('auto-detect-series');
          if (autoDetect) autoDetect.checked = mappings.autoDetectSeries !== false;
        }
      }
    } catch (e) {
      console.log('Error loading invoice series settings:', e);
    }
  }

  /**
   * Detect invoice number prefix by fetching voucher numbers directly from Tally
   */
  async function detectPrefixFromTally(detectedSpan) {
    try {
      const result = await window.setu.fetchRecentVoucherNumbers();
      if (!result.success || !result.voucherNumbers || result.voucherNumbers.length === 0) {
        detectedSpan.textContent = 'No invoices found in Tally';
        detectedSpan.style.color = 'var(--gray-500)';
        return;
      }

      const numbers = result.voucherNumbers;

      // Detect prefix from voucher numbers
      // Match common patterns like 'INV-001', 'SALES/2024/001', 'GST-001', 'A/001', etc.
      const prefixCounts = {};
      for (const num of numbers) {
        const match = num.match(/^([A-Za-z]+[-/]?)/);
        if (match) {
          const prefix = match[1];
          prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
        }
      }

      // Find the most common prefix
      let detectedPrefix = '';
      let maxCount = 0;
      for (const [prefix, count] of Object.entries(prefixCounts)) {
        if (count > maxCount) {
          maxCount = count;
          detectedPrefix = prefix;
        }
      }

      if (detectedPrefix) {
        // Show detected prefix with sample numbers
        const samples = numbers.slice(0, 3).join(', ');
        detectedSpan.textContent = `"${detectedPrefix}" (from ${numbers.length} invoices, e.g., ${samples})`;
        detectedSpan.style.color = 'var(--success)';
      } else {
        // No prefix pattern — show sample numbers
        const samples = numbers.slice(0, 3).join(', ');
        detectedSpan.textContent = `Numeric only (e.g., ${samples})`;
        detectedSpan.style.color = 'var(--info, var(--primary))';
      }
    } catch (e) {
      console.log('Error detecting prefix from Tally:', e);
      detectedSpan.textContent = 'Could not detect (Tally not connected?)';
      detectedSpan.style.color = 'var(--gray-500)';
    }
  }

  async function saveInvoiceSeriesSettings(e) {
    e.preventDefault();

    const selectedMode = document.querySelector('input[name="invoice-number-mode"]:checked')?.value || 'keep';
    const customPrefix = document.getElementById('tally-invoice-prefix')?.value || '';
    const autoDetect = document.getElementById('auto-detect-series')?.checked ?? true;

    const settings = {
      invoiceNumberMode: selectedMode,
      tallyInvoicePrefix: customPrefix,
      autoDetectSeries: autoDetect
    };

    try {
      // Save to backend
      const result = await window.setu.saveLedgerMappings(settings);

      // Also save locally for quick access
      await window.setu.saveConfig({ invoiceSeriesSettings: settings });

      if (result.success) {
        showToast('Invoice series settings saved successfully', 'success');
      } else {
        showToast(result.error || 'Failed to save settings', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    }
  }

  // ==========================================
  // SYNC INVOICES
  // ==========================================

  async function handleSyncInvoices(e) {
    e.preventDefault();

    const startDate = document.getElementById('sync-start-date').value;
    const endDate = document.getElementById('sync-end-date').value;
    const forceResync = document.getElementById('force-resync').checked;

    if (!startDate || !endDate) {
      showToast('Please select date range', 'error');
      return;
    }

    const btn = document.getElementById('sync-invoices-btn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';

    try {
      const result = await window.setu.syncInvoices({ startDate, endDate, forceResync });

      if (result.success) {
        document.getElementById('sync-result').classList.remove('hidden');
        document.getElementById('sync-success-count').textContent = result.success_count || 0;
        document.getElementById('sync-failed-count').textContent = result.failed_count || 0;
        document.getElementById('sync-skipped-count').textContent = result.skipped_count || 0;
        showToast('Sync completed', 'success');
        lastSyncTime.textContent = formatDate(new Date().toISOString());
      } else {
        showToast(result.error || 'Sync failed', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Preview & Sync Invoices';
    }
  }

  // ==========================================
  // IMPORT FROM TALLY - COMPANY MASTER
  // ==========================================

  async function fetchCompanyFromTally() {
    const btn = document.getElementById('fetch-company-btn');
    const loading = document.getElementById('company-loading');
    const formContainer = document.getElementById('company-form-container');
    const resultDiv = document.getElementById('company-result');
    const fetchSection = btn.closest('.fetch-section');

    btn.disabled = true;
    btn.innerHTML = `
      <svg class="spinning" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 11-6.219-8.56"/>
      </svg>
      Fetching...
    `;
    loading.classList.remove('hidden');
    formContainer.classList.add('hidden');
    resultDiv.classList.add('hidden');

    try {
      const result = await window.setu.fetchCompanyDetails();

      if (result.success && result.companyDetails) {
        const company = result.companyDetails;

        // Populate form fields
        document.getElementById('company-name').value = company.companyName || '';
        document.getElementById('company-trading-name').value = company.tradingName || '';
        document.getElementById('company-address').value = company.address || '';
        document.getElementById('company-city').value = company.city || '';
        document.getElementById('company-state').value = company.state || '';
        document.getElementById('company-pincode').value = company.pinCode || '';
        document.getElementById('company-gstin').value = company.gstin || '';
        document.getElementById('company-state-code').value = company.stateCode || '';
        document.getElementById('company-pan').value = company.pan || '';
        document.getElementById('company-phone').value = company.phone || '';
        document.getElementById('company-email').value = company.email || '';

        formContainer.classList.remove('hidden');
        if (fetchSection) fetchSection.classList.add('hidden');
        showToast('Company details fetched from Tally', 'success');
      } else {
        showToast(result.error || 'Failed to fetch company details', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Fetch Company Details from Tally
      `;
      loading.classList.add('hidden');
    }
  }

  async function syncCompanyToNexInvo() {
    const btn = document.getElementById('sync-company-btn');
    const resultDiv = document.getElementById('company-result');

    const companyData = {
      companyName: document.getElementById('company-name').value.trim(),
      tradingName: document.getElementById('company-trading-name').value.trim(),
      address: document.getElementById('company-address').value.trim(),
      city: document.getElementById('company-city').value.trim(),
      state: document.getElementById('company-state').value.trim(),
      pinCode: document.getElementById('company-pincode').value.trim(),
      gstin: document.getElementById('company-gstin').value.trim(),
      stateCode: document.getElementById('company-state-code').value.trim(),
      pan: document.getElementById('company-pan').value.trim(),
      phone: document.getElementById('company-phone').value.trim(),
      email: document.getElementById('company-email').value.trim()
    };

    // Validate required fields
    const requiredFields = [
      { key: 'companyName', id: 'company-name', label: 'Company Name' },
      { key: 'address', id: 'company-address', label: 'Address' },
      { key: 'city', id: 'company-city', label: 'City' },
      { key: 'state', id: 'company-state', label: 'State' }
    ];

    // Clear previous validation highlights
    document.querySelectorAll('.company-form-grid input.field-error').forEach(el => {
      el.classList.remove('field-error');
    });

    const missing = requiredFields.filter(f => !companyData[f.key]);
    if (missing.length > 0) {
      missing.forEach(f => {
        const input = document.getElementById(f.id);
        if (input) {
          input.classList.add('field-error');
          input.addEventListener('input', function handler() {
            input.classList.remove('field-error');
            input.removeEventListener('input', handler);
          });
        }
      });
      const names = missing.map(f => f.label).join(', ');
      showToast(`Please fill required fields: ${names}`, 'error');
      // Focus the first missing field
      const firstMissing = document.getElementById(missing[0].id);
      if (firstMissing) firstMissing.focus();
      return;
    }

    btn.disabled = true;
    btn.innerHTML = `
      <svg class="spinning" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 11-6.219-8.56"/>
      </svg>
      Syncing...
    `;

    try {
      const result = await window.setu.syncCompanyToNexInvo(companyData);

      if (result.success) {
        resultDiv.innerHTML = `
          <div class="result-success">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <span>Company details synced to NexInvo successfully!</span>
          </div>
        `;
        resultDiv.classList.remove('hidden');
        showToast('Company details synced to NexInvo', 'success');
      } else {
        resultDiv.innerHTML = `
          <div class="result-error">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            <span>${result.error || 'Failed to sync company details'}</span>
          </div>
        `;
        resultDiv.classList.remove('hidden');
        showToast(result.error || 'Failed to sync', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14"/>
          <path d="M12 5l7 7-7 7"/>
        </svg>
        Sync to NexInvo
      `;
    }
  }

  // ==========================================
  // IMPORT FROM TALLY - PARTIES/CLIENTS
  // ==========================================

  async function fetchPartiesFromTally() {
    const btn = document.getElementById('fetch-parties-btn');
    const loading = document.getElementById('parties-loading');
    const list = document.getElementById('parties-list');
    const fetchSection = btn.closest('.fetch-section');

    btn.disabled = true;
    btn.innerHTML = `
      <svg class="spinning" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 11-6.219-8.56"/>
      </svg>
      Fetching...
    `;
    loading.classList.remove('hidden');
    list.classList.add('hidden');
    updateImportStep(2);

    try {
      const result = await window.setu.fetchParties();

      if (result.success && result.parties) {
        tallyParties = result.parties;
        selectedParties.clear();
        renderPartiesList();
        list.classList.remove('hidden');
        if (fetchSection) fetchSection.classList.add('hidden');
        document.getElementById('parties-count').textContent = `${result.parties.length} parties found`;
        updateImportStep(3);
        showToast(`Found ${result.parties.length} parties in Tally`, 'success');
      } else {
        showToast(result.error || 'Failed to fetch parties', 'error');
        updateImportStep(2);
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
      updateImportStep(2);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Fetch Parties from Tally
      `;
      loading.classList.add('hidden');
    }
  }

  function renderPartiesList() {
    const container = document.getElementById('parties-items');
    const importBtn = document.getElementById('import-clients-btn');
    const selectAllCheckbox = document.getElementById('select-all-parties');
    const selectedCountEl = document.getElementById('parties-selected-count');

    console.log(`renderPartiesList: ${tallyParties.length} parties, ${selectedParties.size} selected`);

    container.innerHTML = tallyParties.map((party, idx) => `
      <div class="item-card ${selectedParties.has(idx) ? 'selected' : ''}" data-idx="${idx}">
        <div class="item-checkbox"></div>
        <div class="item-info">
          <div class="item-name">${escapeHtml(party.name)}</div>
          <div class="item-detail">${party.gstin || 'No GSTIN'} | ${party.state || 'N/A'}</div>
        </div>
        ${party.gstin ? '<span class="item-badge">GST</span>' : ''}
      </div>
    `).join('');

    // Add click handlers
    container.querySelectorAll('.item-card').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.idx);
        if (selectedParties.has(idx)) {
          selectedParties.delete(idx);
        } else {
          selectedParties.add(idx);
        }
        renderPartiesList();
      });
    });

    // Update select all checkbox state
    if (selectAllCheckbox) {
      selectAllCheckbox.checked = tallyParties.length > 0 && selectedParties.size === tallyParties.length;
    }

    // Update selected count
    if (selectedCountEl) {
      selectedCountEl.textContent = `${selectedParties.size} selected`;
    }

    importBtn.disabled = selectedParties.size === 0;
  }

  async function previewImportClients() {
    if (selectedParties.size === 0) {
      showToast('Please select parties to import', 'error');
      return;
    }

    const partiesToImport = Array.from(selectedParties).map(idx => tallyParties[idx]);

    try {
      const result = await window.setu.previewImportClients(partiesToImport);

      if (result.success) {
        showImportPreviewModal('clients', result);
      } else {
        showToast(result.error || 'Failed to preview', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    }
  }

  // ==========================================
  // IMPORT FROM TALLY - STOCK ITEMS
  // ==========================================

  async function fetchStockFromTally() {
    const btn = document.getElementById('fetch-stock-btn');
    const loading = document.getElementById('stock-loading');
    const list = document.getElementById('stock-list');
    const fetchSection = btn.closest('.fetch-section');

    btn.disabled = true;
    btn.innerHTML = `
      <svg class="spinning" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 11-6.219-8.56"/>
      </svg>
      Fetching...
    `;
    loading.classList.remove('hidden');
    list.classList.add('hidden');
    updateImportStep(2);

    try {
      // First try stock items (for goods traders)
      const result = await window.setu.fetchStockItems();

      if (result.success && result.stockItems && result.stockItems.length > 0) {
        tallyStockItems = result.stockItems;
        stockItemsAreServices = false;
        selectedStockItems.clear();
        renderStockList();
        list.classList.remove('hidden');
        if (fetchSection) fetchSection.classList.add('hidden');
        document.getElementById('stock-count').textContent = `${result.stockItems.length} items found`;
        updateImportStep(3);
        showToast(`Found ${result.stockItems.length} stock items in Tally`, 'success');
      } else {
        // No stock items found — try service ledgers (Sales Accounts)
        console.log('No stock items found, trying service ledgers from Sales Accounts...');
        const serviceResult = await window.setu.fetchServiceLedgers();

        if (serviceResult.success && serviceResult.serviceLedgers && serviceResult.serviceLedgers.length > 0) {
          tallyStockItems = serviceResult.serviceLedgers;
          stockItemsAreServices = true;
          selectedStockItems.clear();
          renderStockList();
          list.classList.remove('hidden');
          if (fetchSection) fetchSection.classList.add('hidden');
          document.getElementById('stock-count').textContent = `${serviceResult.serviceLedgers.length} services found`;
          updateImportStep(3);
          showToast(`Found ${serviceResult.serviceLedgers.length} services in Tally (Sales Accounts)`, 'success');
        } else {
          showToast('No stock items or services found in Tally', 'error');
          updateImportStep(2);
        }
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
      updateImportStep(2);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Fetch from Tally
      `;
      loading.classList.add('hidden');
    }
  }

  function renderStockList() {
    const container = document.getElementById('stock-items');
    const importBtn = document.getElementById('import-products-btn');
    const selectAllCheckbox = document.getElementById('select-all-stock');
    const selectedCountEl = document.getElementById('stock-selected-count');

    console.log(`renderStockList: ${tallyStockItems.length} items, ${selectedStockItems.size} selected`);

    container.innerHTML = tallyStockItems.map((item, idx) => `
      <div class="item-card ${selectedStockItems.has(idx) ? 'selected' : ''}" data-idx="${idx}">
        <div class="item-checkbox"></div>
        <div class="item-info">
          <div class="item-name">${escapeHtml(item.name)}</div>
          <div class="item-detail">${stockItemsAreServices
            ? `Group: ${item.group || 'Sales Accounts'}`
            : `HSN: ${item.hsn_code || 'N/A'} | Rate: ${item.rate || 0}`}</div>
        </div>
        ${stockItemsAreServices
          ? '<span class="item-badge" style="background:linear-gradient(135deg,#8b5cf6,#a855f7)">Service</span>'
          : (item.hsn_code ? '<span class="item-badge">HSN</span>' : '')}
      </div>
    `).join('');

    // Add click handlers
    container.querySelectorAll('.item-card').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.idx);
        if (selectedStockItems.has(idx)) {
          selectedStockItems.delete(idx);
        } else {
          selectedStockItems.add(idx);
        }
        renderStockList();
      });
    });

    // Update select all checkbox state
    if (selectAllCheckbox) {
      selectAllCheckbox.checked = tallyStockItems.length > 0 && selectedStockItems.size === tallyStockItems.length;
    }

    // Update selected count
    if (selectedCountEl) {
      selectedCountEl.textContent = `${selectedStockItems.size} selected`;
    }

    importBtn.disabled = selectedStockItems.size === 0;
  }

  async function previewImportProducts() {
    if (selectedStockItems.size === 0) {
      showToast('Please select items to import', 'error');
      return;
    }

    const itemsToImport = Array.from(selectedStockItems).map(idx => tallyStockItems[idx]);

    try {
      // Use services or products endpoint based on what was fetched
      const result = stockItemsAreServices
        ? await window.setu.previewImportServices(itemsToImport)
        : await window.setu.previewImportProducts(itemsToImport);

      if (result.success) {
        showImportPreviewModal(stockItemsAreServices ? 'services' : 'products', result);
      } else {
        showToast(result.error || 'Failed to preview', 'error');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    }
  }

  // ==========================================
  // IMPORT PREVIEW MODAL
  // ==========================================

  function showImportPreviewModal(type, data) {
    // Remove existing modal if any
    document.querySelector('.modal-overlay')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Import ${type === 'clients' ? 'Clients' : 'Products'} Preview</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${data.to_create?.length > 0 ? `
            <div class="preview-section">
              <h4>New (Will be Created) <span class="preview-count">${data.create_count}</span></h4>
              <div class="preview-list">
                ${data.to_create.map(item => `
                  <div class="preview-item">
                    <div>
                      <div class="preview-item-name">${escapeHtml(item.name)}</div>
                      <div class="preview-item-detail">${type === 'clients' ? (item.gstin || 'No GSTIN') : (item.hsn_code || 'No HSN')}</div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${data.to_update?.length > 0 ? `
            <div class="preview-section">
              <h4>Existing (Will be Updated) <span class="preview-count">${data.update_count}</span></h4>
              <div class="preview-list">
                ${data.to_update.map(item => `
                  <div class="preview-item">
                    <div>
                      <div class="preview-item-name">${escapeHtml(item.tally_name || item.name)}</div>
                      <div class="preview-item-detail">Matched: ${escapeHtml(item.nexinvo_name || 'N/A')}</div>
                    </div>
                    <span class="match-badge ${item.match_type || 'name'}">${item.match_type === 'gstin' ? 'GSTIN' : item.match_type === 'hsn_code' ? 'HSN' : 'Name'}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${(!data.to_create?.length && !data.to_update?.length) ? `
            <p class="empty-state">No items to import</p>
          ` : ''}
        </div>
        <div class="modal-footer">
          <div class="summary">
            ${data.create_count || 0} new, ${data.update_count || 0} existing
          </div>
          <div class="actions">
            <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
            <button class="btn btn-primary" id="modal-confirm">Confirm Import</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event handlers
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#modal-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#modal-confirm').addEventListener('click', async () => {
      modal.remove();
      await executeImport(type);
    });

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  }

  async function executeImport(type) {
    try {
      let result;
      if (type === 'clients') {
        const partiesToImport = Array.from(selectedParties).map(idx => tallyParties[idx]);
        result = await window.setu.importClients(partiesToImport);
      } else if (type === 'services') {
        const itemsToImport = Array.from(selectedStockItems).map(idx => tallyStockItems[idx]);
        result = await window.setu.importServices(itemsToImport);
      } else {
        const itemsToImport = Array.from(selectedStockItems).map(idx => tallyStockItems[idx]);
        result = await window.setu.importProducts(itemsToImport);
      }

      const created = result.created_count || result.created || 0;
      const updated = result.updated_count || result.updated || 0;
      const importErrors = result.errors || [];

      if (result.success && (created > 0 || updated > 0)) {
        showToast(`Imported: ${created} created, ${updated} updated`, 'success');
        // Clear selections
        if (type === 'clients') {
          selectedParties.clear();
          renderPartiesList();
        } else {
          selectedStockItems.clear();
          renderStockList();
        }
      } else if (importErrors.length > 0) {
        // Show first error to help debug
        console.error('Import errors:', importErrors);
        const errorSummary = importErrors.length === 1
          ? importErrors[0]
          : `${importErrors.length} errors. First: ${importErrors[0]}`;
        showToast(`Import failed: ${errorSummary}`, 'error');
      } else if (!result.success) {
        showToast(result.error || 'Import failed', 'error');
      } else {
        showToast(`Imported: ${created} created, ${updated} updated`, 'success');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
    }
  }

  // ==========================================
  // REAL-TIME SYNC FUNCTIONS
  // ==========================================

  function startAutoSync() {
    // Get interval from selected option or custom input
    const selectedInterval = document.querySelector('input[name="sync-interval"]:checked')?.value;
    if (selectedInterval === 'custom') {
      // Support both old and new IDs for custom input
      const customInput = document.getElementById('custom-interval-value') || document.getElementById('custom-minutes');
      const customValue = parseInt(customInput?.value || '15');
      autoSyncIntervalMinutes = Math.max(1, Math.min(1440, customValue));
    } else if (selectedInterval) {
      autoSyncIntervalMinutes = parseInt(selectedInterval);
    } else {
      autoSyncIntervalMinutes = 15; // Default to 15 minutes
    }

    autoSyncEnabled = true;

    // Update UI
    updateAutoSyncUI(true);

    // Perform first sync immediately
    performAutoSync();

    // Set up interval for subsequent syncs
    autoSyncInterval = setInterval(() => {
      performAutoSync();
    }, autoSyncIntervalMinutes * 60 * 1000);

    // Start countdown timer
    startCountdown();

    showToast(`Auto-sync started (every ${autoSyncIntervalMinutes} min)`, 'success');
    addSyncLogEntry('info', `Auto-sync enabled - syncing every ${autoSyncIntervalMinutes} minutes`);
  }

  function stopAutoSync() {
    autoSyncEnabled = false;

    if (autoSyncInterval) {
      clearInterval(autoSyncInterval);
      autoSyncInterval = null;
    }

    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    // Update UI
    updateAutoSyncUI(false);
    document.getElementById('next-sync-countdown').textContent = '--:--';

    showToast('Auto-sync stopped', 'info');
    addSyncLogEntry('info', 'Auto-sync disabled');
  }

  function updateAutoSyncUI(enabled) {
    const pulse = document.getElementById('sync-pulse');
    const statusText = document.getElementById('auto-sync-status-text');
    const startBtn = document.getElementById('start-auto-sync-btn');
    const stopBtn = document.getElementById('stop-auto-sync-btn');

    if (pulse) {
      if (enabled) {
        pulse.classList.add('active');
      } else {
        pulse.classList.remove('active', 'syncing');
      }
    }

    if (statusText) {
      statusText.textContent = enabled ? 'Auto-Sync Active' : 'Auto-Sync Disabled';
      statusText.style.color = enabled ? 'var(--success)' : 'var(--gray-700)';
    }

    if (startBtn) {
      if (enabled) {
        startBtn.textContent = 'Stop Auto-Sync';
        startBtn.classList.remove('btn-primary');
        startBtn.classList.add('btn-danger');
        startBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="6" y="6" width="12" height="12"/>
          </svg>
          Stop Auto-Sync
        `;
        startBtn.removeEventListener('click', startAutoSync);
        startBtn.addEventListener('click', stopAutoSync);
      } else {
        startBtn.classList.remove('btn-danger');
        startBtn.classList.add('btn-primary');
        startBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Start Auto-Sync
        `;
        startBtn.removeEventListener('click', stopAutoSync);
        startBtn.addEventListener('click', startAutoSync);
      }
    }
  }

  function startCountdown() {
    nextSyncTime = Date.now() + (autoSyncIntervalMinutes * 60 * 1000);

    if (countdownInterval) {
      clearInterval(countdownInterval);
    }

    countdownInterval = setInterval(() => {
      const remaining = nextSyncTime - Date.now();

      if (remaining <= 0) {
        document.getElementById('next-sync-countdown').textContent = 'Syncing...';
        return;
      }

      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      document.getElementById('next-sync-countdown').textContent =
        `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
  }

  async function performAutoSync() {
    if (!autoSyncEnabled) return;

    const pulse = document.getElementById('sync-pulse');
    if (pulse) pulse.classList.add('syncing');

    try {
      addSyncLogEntry('info', 'Starting automatic sync...');

      const result = await window.setu.performRealtimeSync();

      if (result.success) {
        const totalSynced = (result.to_tally_count || 0) + (result.to_nexinvo_count || 0);
        invoicesSyncedToday += totalSynced;
        syncsTodayCount++;

        // Update stats (support various element IDs)
        const lastSyncEl = document.getElementById('last-auto-sync-time');
        const syncsTodayEl = document.getElementById('total-syncs-today') || document.getElementById('syncs-today');
        const invoicesSyncedEl = document.getElementById('invoices-synced-today');

        if (lastSyncEl) lastSyncEl.textContent = formatTime(new Date().toISOString());
        if (syncsTodayEl) syncsTodayEl.textContent = syncsTodayCount;
        if (invoicesSyncedEl) invoicesSyncedEl.textContent = invoicesSyncedToday;

        // Show sync period info
        const periodInfo = result.sync_period ?
          ` (${formatDateShort(result.sync_period.start)} to ${formatDateShort(result.sync_period.end)})` : '';
        const firstSyncNote = result.is_first_sync ? ' [First sync - Full FY]' : '';

        if (totalSynced > 0) {
          addSyncLogEntry('success', `Synced ${result.to_tally_count || 0} to Tally, ${result.to_nexinvo_count || 0} to NexInvo${periodInfo}${firstSyncNote}`);
        } else {
          // Show detailed info when nothing synced
          const previewInfo = result.preview_to_tally !== undefined ?
            ` (Found: ${result.preview_to_tally || 0} pending to Tally, ${result.preview_to_nexinvo || 0} pending to NexInvo, ${result.tally_vouchers_fetched || 0} from Tally)` : '';
          const syncNote = (result.preview_to_tally === 0 && result.preview_to_nexinvo === 0 && result.matched_count === 0) ?
            ' - Note: Only sent/paid invoices are synced' : '';
          addSyncLogEntry('success', `Sync complete - ${result.matched_count || 0} matched${periodInfo}${firstSyncNote}${previewInfo}${syncNote}`);
        }
      } else {
        addSyncLogEntry('error', result.error || 'Sync failed');
      }
    } catch (error) {
      addSyncLogEntry('error', `Error: ${error.message}`);
    } finally {
      if (pulse) pulse.classList.remove('syncing');
      // Reset countdown for next sync
      if (autoSyncEnabled) {
        startCountdown();
      }
    }
  }

  // Helper function to format date as short format (DD MMM)
  function formatDateShort(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    } catch {
      return dateStr;
    }
  }

  async function performManualSync() {
    // Support both old and new button IDs
    const btn = document.getElementById('manual-sync-now-btn') || document.getElementById('manual-sync-btn');
    const pulse = document.getElementById('sync-pulse');

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning">
          <path d="M23 4v6h-6M1 20v-6h6"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        Syncing...
      `;
    }
    if (pulse) pulse.classList.add('syncing');

    try {
      addSyncLogEntry('info', 'Starting manual sync...');

      const result = await window.setu.performRealtimeSync();

      if (result.success) {
        const totalSynced = (result.to_tally_count || 0) + (result.to_nexinvo_count || 0);
        invoicesSyncedToday += totalSynced;
        syncsTodayCount++;

        // Update stats (support various element IDs)
        const syncsTodayEl = document.getElementById('total-syncs-today') || document.getElementById('syncs-today');
        const invoicesSyncedEl = document.getElementById('invoices-synced-today');

        if (syncsTodayEl) syncsTodayEl.textContent = syncsTodayCount;
        if (invoicesSyncedEl) invoicesSyncedEl.textContent = invoicesSyncedToday;

        // Show sync period info
        const periodInfo = result.sync_period ?
          ` (${formatDateShort(result.sync_period.start)} to ${formatDateShort(result.sync_period.end)})` : '';
        const firstSyncNote = result.is_first_sync ? ' [First sync - Full FY]' : '';

        if (totalSynced > 0) {
          showToast(`Synced ${totalSynced} invoices${firstSyncNote}`, 'success');
          addSyncLogEntry('success', `Synced ${result.to_tally_count || 0} to Tally, ${result.to_nexinvo_count || 0} to NexInvo${periodInfo}${firstSyncNote}`);
        } else {
          showToast(`All invoices already in sync${firstSyncNote}`, 'success');
          addSyncLogEntry('success', `All invoices in sync (${result.matched_count || 0} matched)${periodInfo}${firstSyncNote}`);
        }
      } else {
        showToast(result.error || 'Sync failed', 'error');
        addSyncLogEntry('error', result.error || 'Sync failed');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
      addSyncLogEntry('error', `Error: ${error.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          Sync Now
        `;
      }
      if (pulse) pulse.classList.remove('syncing');
    }
  }

  // ==========================================
  // MANUAL SYNC WITH PREVIEW
  // ==========================================

  // Store preview data for use in sync execution
  let manualSyncPreviewData = {
    toTally: [],
    toNexinvo: [],
    matched: [],
    selectedToTally: new Set(),
    selectedToNexinvo: new Set()
  };

  function setupManualSyncListeners() {
    console.log('[ManualSync] Setting up manual sync listeners...');

    // Fetch & Compare button
    const fetchBtn = document.getElementById('fetch-sync-preview-btn');
    if (fetchBtn) {
      console.log('[ManualSync] Found fetch-sync-preview-btn, attaching click handler');
      fetchBtn.addEventListener('click', () => {
        console.log('[ManualSync] Fetch & Compare button clicked');
        fetchManualSyncPreview();
      });
    } else {
      console.error('[ManualSync] fetch-sync-preview-btn not found!');
    }

    // Tab switching
    document.querySelectorAll('.sync-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabId = tab.dataset.syncTab;
        switchSyncPreviewTab(tabId);
      });
    });

    // Select All checkboxes
    document.getElementById('select-all-to-nexinvo')?.addEventListener('change', (e) => {
      toggleSelectAllSync('to-nexinvo', e.target.checked);
    });
    document.getElementById('select-all-to-tally')?.addEventListener('change', (e) => {
      toggleSelectAllSync('to-tally', e.target.checked);
    });

    // Action buttons
    document.getElementById('cancel-sync-btn')?.addEventListener('click', resetManualSync);
    document.getElementById('execute-sync-btn')?.addEventListener('click', executeManualSync);
    document.getElementById('new-sync-btn')?.addEventListener('click', resetManualSync);

    // Set default dates (last 30 days)
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    const startDateInput = document.getElementById('manual-sync-start-date');
    const endDateInput = document.getElementById('manual-sync-end-date');

    if (startDateInput) {
      startDateInput.value = thirtyDaysAgo.toISOString().split('T')[0];
      console.log('[ManualSync] Set start date to:', startDateInput.value);
    }
    if (endDateInput) {
      endDateInput.value = today.toISOString().split('T')[0];
      console.log('[ManualSync] Set end date to:', endDateInput.value);
    }

    console.log('[ManualSync] Setup complete');
  }

  async function fetchManualSyncPreview() {
    console.log('[ManualSync] fetchManualSyncPreview called');

    const startDate = document.getElementById('manual-sync-start-date')?.value;
    const endDate = document.getElementById('manual-sync-end-date')?.value;

    console.log('[ManualSync] Date range:', startDate, 'to', endDate);

    if (!startDate || !endDate) {
      showToast('Please select both start and end dates', 'error');
      console.log('[ManualSync] Missing dates, aborting');
      return;
    }

    const fetchBtn = document.getElementById('fetch-sync-preview-btn');
    const loading = document.getElementById('manual-sync-loading');
    const results = document.getElementById('sync-preview-results');

    console.log('[ManualSync] Elements found - fetchBtn:', !!fetchBtn, 'loading:', !!loading, 'results:', !!results);

    // Show loading state
    if (fetchBtn) {
      fetchBtn.disabled = true;
      fetchBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning">
          <path d="M23 4v6h-6M1 20v-6h6"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        Fetching...
      `;
    }
    loading?.classList.remove('hidden');
    results?.classList.add('hidden');

    try {
      console.log('[ManualSync] Calling window.setu.getManualSyncPreview...');
      const result = await window.setu.getManualSyncPreview({ startDate, endDate });
      console.log('[ManualSync] Result received:', result);

      if (result.success) {
        manualSyncPreviewData.toTally = result.to_tally || [];
        manualSyncPreviewData.toNexinvo = result.to_nexinvo || [];
        manualSyncPreviewData.matched = result.matched || [];
        manualSyncPreviewData.selectedToTally = new Set();
        manualSyncPreviewData.selectedToNexinvo = new Set();

        // Update summary counts
        document.getElementById('matched-count').textContent = manualSyncPreviewData.matched.length;
        document.getElementById('to-nexinvo-count').textContent = manualSyncPreviewData.toNexinvo.length;
        document.getElementById('to-tally-count').textContent = manualSyncPreviewData.toTally.length;
        document.getElementById('tab-matched-count').textContent = manualSyncPreviewData.matched.length;
        document.getElementById('tab-to-nexinvo-count').textContent = manualSyncPreviewData.toNexinvo.length;
        document.getElementById('tab-to-tally-count').textContent = manualSyncPreviewData.toTally.length;

        // Render invoice lists
        renderSyncList('to-nexinvo', manualSyncPreviewData.toNexinvo);
        renderSyncList('to-tally', manualSyncPreviewData.toTally);
        renderMatchedList(manualSyncPreviewData.matched);

        // Show first non-empty tab
        if (manualSyncPreviewData.toNexinvo.length > 0) {
          switchSyncPreviewTab('to-nexinvo');
        } else if (manualSyncPreviewData.toTally.length > 0) {
          switchSyncPreviewTab('to-tally');
        } else {
          switchSyncPreviewTab('matched');
        }

        // Show results
        loading?.classList.add('hidden');
        results?.classList.remove('hidden');

        updateSelectedCount();
      } else {
        showToast(result.error || 'Failed to fetch preview', 'error');
        loading?.classList.add('hidden');
      }
    } catch (error) {
      showToast(`Error: ${error.message}`, 'error');
      loading?.classList.add('hidden');
    } finally {
      if (fetchBtn) {
        fetchBtn.disabled = false;
        fetchBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Fetch & Compare Invoices
        `;
      }
    }
  }

  function renderSyncList(type, invoices) {
    const container = document.getElementById(`${type}-list`);
    if (!container) return;

    if (!invoices || invoices.length === 0) {
      container.innerHTML = '<p class="empty-state">No invoices to sync</p>';
      return;
    }

    const selectedSet = type === 'to-tally' ? manualSyncPreviewData.selectedToTally : manualSyncPreviewData.selectedToNexinvo;

    container.innerHTML = invoices.map((inv, index) => {
      const id = type === 'to-tally' ? inv.id : (inv.voucher_number || inv.id || index);
      const invoiceNumber = type === 'to-tally' ? inv.invoice_number : (inv.voucher_number || inv.invoice_number || 'N/A');
      const date = inv.invoice_date || inv.date || inv.voucher_date || '';
      const clientName = type === 'to-tally' ? (inv.client_name || inv.client?.name || 'Unknown') : (inv.party_name || inv.client_name || 'Unknown');
      const amount = parseFloat(inv.total_amount || inv.total || inv.amount || 0).toFixed(2);
      const isChecked = selectedSet.has(id);

      return `
        <label class="sync-item ${isChecked ? 'selected' : ''}">
          <input type="checkbox" data-type="${type}" data-id="${id}" data-index="${index}" ${isChecked ? 'checked' : ''}>
          <span class="checkmark"></span>
          <div class="sync-item-content">
            <div class="sync-item-header">
              <span class="invoice-number">${escapeHtml(invoiceNumber)}</span>
              <span class="invoice-amount">₹${amount}</span>
            </div>
            <div class="sync-item-details">
              <span class="client-name">${escapeHtml(clientName)}</span>
              <span class="invoice-date">${formatDate(date)}</span>
            </div>
          </div>
        </label>
      `;
    }).join('');

    // Add event listeners to checkboxes
    container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const itemType = e.target.dataset.type;
        const id = e.target.dataset.id;
        const index = parseInt(e.target.dataset.index);
        const selectedSet = itemType === 'to-tally' ? manualSyncPreviewData.selectedToTally : manualSyncPreviewData.selectedToNexinvo;

        if (e.target.checked) {
          selectedSet.add(itemType === 'to-tally' ? id : index);
        } else {
          selectedSet.delete(itemType === 'to-tally' ? id : index);
        }

        // Update visual state
        e.target.closest('.sync-item').classList.toggle('selected', e.target.checked);

        // Update select-all checkbox state
        updateSelectAllState(itemType);
        updateSelectedCount();
      });
    });
  }

  function renderMatchedList(invoices) {
    const container = document.getElementById('matched-list');
    if (!container) return;

    if (!invoices || invoices.length === 0) {
      container.innerHTML = '<p class="empty-state">No matched invoices</p>';
      return;
    }

    container.innerHTML = invoices.map(inv => {
      const invoiceNumber = inv.invoice_number || inv.voucher_number || 'N/A';
      const date = inv.invoice_date || inv.date || inv.voucher_date || '';
      const clientName = inv.client_name || inv.party_name || 'Unknown';
      const amount = parseFloat(inv.total_amount || inv.total || inv.amount || 0).toFixed(2);

      return `
        <div class="sync-item matched-item">
          <div class="matched-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div class="sync-item-content">
            <div class="sync-item-header">
              <span class="invoice-number">${escapeHtml(invoiceNumber)}</span>
              <span class="invoice-amount">₹${amount}</span>
            </div>
            <div class="sync-item-details">
              <span class="client-name">${escapeHtml(clientName)}</span>
              <span class="invoice-date">${formatDate(date)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function switchSyncPreviewTab(tabId) {
    // Update tab buttons
    document.querySelectorAll('.sync-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.syncTab === tabId);
    });

    // Update sections
    document.querySelectorAll('.sync-preview-section').forEach(section => {
      section.classList.add('hidden');
    });
    document.getElementById(`section-${tabId}`)?.classList.remove('hidden');
  }

  function toggleSelectAllSync(type, checked) {
    const container = document.getElementById(`${type}-list`);
    const selectedSet = type === 'to-tally' ? manualSyncPreviewData.selectedToTally : manualSyncPreviewData.selectedToNexinvo;
    const dataList = type === 'to-tally' ? manualSyncPreviewData.toTally : manualSyncPreviewData.toNexinvo;

    if (checked) {
      dataList.forEach((inv, index) => {
        const id = type === 'to-tally' ? inv.id : index;
        selectedSet.add(id);
      });
    } else {
      selectedSet.clear();
    }

    // Update checkboxes
    container?.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.checked = checked;
      checkbox.closest('.sync-item')?.classList.toggle('selected', checked);
    });

    updateSelectedCount();
  }

  function updateSelectAllState(type) {
    const selectAllCheckbox = document.getElementById(`select-all-${type}`);
    const container = document.getElementById(`${type}-list`);
    if (!selectAllCheckbox || !container) return;

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    const checkedCount = container.querySelectorAll('input[type="checkbox"]:checked').length;

    selectAllCheckbox.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
  }

  function updateSelectedCount() {
    const totalSelected = manualSyncPreviewData.selectedToTally.size + manualSyncPreviewData.selectedToNexinvo.size;
    const countSpan = document.getElementById('selected-sync-count');
    const executeBtn = document.getElementById('execute-sync-btn');

    if (countSpan) countSpan.textContent = totalSelected;
    if (executeBtn) executeBtn.disabled = totalSelected === 0;
  }

  async function executeManualSync() {
    const selectedToTallyIds = Array.from(manualSyncPreviewData.selectedToTally);
    const selectedToNexinvoIndices = Array.from(manualSyncPreviewData.selectedToNexinvo);
    const selectedToNexinvoVouchers = selectedToNexinvoIndices.map(index => manualSyncPreviewData.toNexinvo[index]);

    if (selectedToTallyIds.length === 0 && selectedToNexinvoVouchers.length === 0) {
      showToast('No invoices selected for sync', 'error');
      return;
    }

    const executeBtn = document.getElementById('execute-sync-btn');
    const previewResults = document.getElementById('sync-preview-results');
    const progressSection = document.getElementById('manual-sync-progress');
    const progressBar = document.getElementById('manual-sync-progress-bar');
    const progressText = document.getElementById('manual-sync-progress-text');
    const statusMessage = document.getElementById('manual-sync-status-message');

    // Show progress
    previewResults?.classList.add('hidden');
    progressSection?.classList.remove('hidden');

    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = '0%';
    if (statusMessage) statusMessage.textContent = 'Starting sync...';

    try {
      // Simulate progress
      let progress = 0;
      const progressInterval = setInterval(() => {
        progress = Math.min(progress + 10, 90);
        if (progressBar) progressBar.style.width = `${progress}%`;
        if (progressText) progressText.textContent = `${progress}%`;
      }, 300);

      const result = await window.setu.executeManualSync({
        toTallyIds: selectedToTallyIds,
        toNexinvoVouchers: selectedToNexinvoVouchers
      });

      clearInterval(progressInterval);

      console.log('[ManualSync] executeManualSync result:', result);

      if (result.success) {
        // Complete progress
        if (progressBar) progressBar.style.width = '100%';
        if (progressText) progressText.textContent = '100%';
        if (statusMessage) statusMessage.textContent = 'Sync completed!';

        // Show result
        setTimeout(() => {
          progressSection?.classList.add('hidden');
          const resultSection = document.getElementById('manual-sync-result');
          resultSection?.classList.remove('hidden');

          document.getElementById('result-to-nexinvo').textContent = result.to_nexinvo_count || 0;
          document.getElementById('result-to-tally').textContent = result.to_tally_count || 0;

          // Update result icon based on success
          const resultIcon = resultSection?.querySelector('.result-icon');
          if (resultIcon) {
            resultIcon.classList.remove('error');
            resultIcon.classList.add('success');
          }

          // Show any errors or skipped info
          if (result.errors && result.errors.length > 0) {
            const errorsInfo = result.errors.join('; ');
            showToast(`Note: ${errorsInfo}`, 'info');
          }
        }, 500);

        showToast(`Synced ${(result.to_tally_count || 0) + (result.to_nexinvo_count || 0)} invoices`, 'success');
      } else {
        throw new Error(result.error || 'Sync failed');
      }
    } catch (error) {
      if (progressBar) progressBar.style.width = '100%';
      if (statusMessage) statusMessage.textContent = `Error: ${error.message}`;
      showToast(`Sync error: ${error.message}`, 'error');

      setTimeout(() => {
        progressSection?.classList.add('hidden');
        previewResults?.classList.remove('hidden');
      }, 2000);
    }
  }

  function resetManualSync() {
    // Reset preview data
    manualSyncPreviewData = {
      toTally: [],
      toNexinvo: [],
      matched: [],
      selectedToTally: new Set(),
      selectedToNexinvo: new Set()
    };

    // Hide all sections except the date range form
    document.getElementById('sync-preview-results')?.classList.add('hidden');
    document.getElementById('manual-sync-progress')?.classList.add('hidden');
    document.getElementById('manual-sync-result')?.classList.add('hidden');
    document.getElementById('manual-sync-loading')?.classList.add('hidden');

    // Reset select-all checkboxes
    const selectAllNexinvo = document.getElementById('select-all-to-nexinvo');
    const selectAllTally = document.getElementById('select-all-to-tally');
    if (selectAllNexinvo) selectAllNexinvo.checked = false;
    if (selectAllTally) selectAllTally.checked = false;

    // Reset execute button
    document.getElementById('selected-sync-count').textContent = '0';
    document.getElementById('execute-sync-btn').disabled = true;
  }

  function addSyncLogEntry(type, message) {
    // Support both old and new IDs
    const logContainer = document.getElementById('realtime-sync-log') || document.getElementById('sync-activity-log');

    if (!logContainer) return;

    // Remove empty state if exists
    const emptyState = logContainer.querySelector('.sync-log-empty') || logContainer.querySelector('.empty-state');
    if (emptyState) {
      emptyState.remove();
    }

    // Create log entry
    const entry = document.createElement('div');
    entry.className = 'sync-log-entry';

    const iconSvg = type === 'success'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
      : type === 'error'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

    entry.innerHTML = `
      <div class="sync-log-icon ${type}">${iconSvg}</div>
      <div class="sync-log-content">
        <div class="sync-log-message">${escapeHtml(message)}</div>
        <div class="sync-log-time">${formatTime(new Date().toISOString())}</div>
      </div>
    `;

    // Add at the top of the log
    logContainer.insertBefore(entry, logContainer.firstChild);

    // Keep only last 50 entries
    const entries = logContainer.querySelectorAll('.sync-log-entry');
    if (entries.length > 50) {
      entries[entries.length - 1].remove();
    }

    syncLogEntries.unshift({ type, message, time: new Date().toISOString() });
  }
});
