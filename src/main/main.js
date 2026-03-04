const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');

// CRITICAL: Suppress stdout/stderr writes BEFORE anything else loads
// This prevents EPIPE errors from winston used by electron-updater
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk, encoding, callback) => {
  try {
    return originalStdoutWrite(chunk, encoding, callback);
  } catch (e) {
    if (typeof callback === 'function') callback();
    return true;
  }
};

process.stderr.write = (chunk, encoding, callback) => {
  try {
    return originalStderrWrite(chunk, encoding, callback);
  } catch (e) {
    if (typeof callback === 'function') callback();
    return true;
  }
};

// Handle EPIPE errors globally
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// Global uncaught exception handler for EPIPE errors
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
});

process.on('unhandledRejection', (reason) => {
  if (reason && reason.code === 'EPIPE') return;
});

// Delay loading these until app is ready to avoid electron-updater initialization issues
let autoUpdater = null;
let logger = null;
let WebSocketClient = null;
let TallyConnector = null;
let QueueManager = null;

function loadModules() {
  // electron-updater removed to fix EPIPE errors
  autoUpdater = null;
  logger = require('./logger');
  WebSocketClient = require('../services/websocket-client');
  TallyConnector = require('../services/tally-connector');
  QueueManager = require('../services/queue-manager');
}

// Simple console logger until full logger is loaded
const consoleLog = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  getRecentLogs: () => []
};

// Initialize store for persistent data
const store = new Store({
  name: 'setu-config',
  defaults: {
    serverUrl: '',
    authToken: '',
    organizationId: '',
    organizationName: '',
    tallyHost: 'localhost',
    tallyPort: 9000,
    appType: '',
    autoStart: true,
    minimizeToTray: true,
    lastSync: null
  }
});

// Helper function to get API headers with organization ID
function getApiHeaders() {
  const authToken = store.get('authToken');
  const organizationId = store.get('organizationId');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`
  };

  if (organizationId) {
    headers['X-Organization-ID'] = organizationId;
  }

  return headers;
}

// JWT Token Refresh Logic
let isRefreshing = false;
let refreshPromise = null;

async function refreshAuthToken() {
  const serverUrl = store.get('serverUrl');
  const refreshToken = store.get('refreshToken');

  if (!serverUrl || !refreshToken) {
    return false;
  }

  try {
    const response = await fetch(`${serverUrl}/api/token/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: refreshToken })
    });

    if (response.ok) {
      const data = await response.json();
      store.set('authToken', data.access);
      if (data.refresh) {
        store.set('refreshToken', data.refresh);
      }
      if (logger) logger.info('JWT token refreshed successfully');
      return true;
    } else {
      if (logger) logger.error(`Token refresh failed: HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    if (logger) logger.error('Token refresh error:', error.message);
    return false;
  }
}

// Deduplicated refresh - prevents multiple concurrent refresh calls
async function ensureValidToken() {
  if (isRefreshing) {
    return refreshPromise;
  }
  isRefreshing = true;
  refreshPromise = refreshAuthToken().finally(() => {
    isRefreshing = false;
    refreshPromise = null;
  });
  return refreshPromise;
}

// Fetch wrapper that auto-refreshes token on 401
async function fetchWithAuth(url, options = {}) {
  options.headers = { ...getApiHeaders(), ...(options.headers || {}) };

  let response = await fetch(url, options);

  if (response.status === 401) {
    const refreshed = await ensureValidToken();
    if (refreshed) {
      // Retry with new token
      options.headers = { ...getApiHeaders(), ...(options.headers || {}) };
      response = await fetch(url, options);
    } else {
      // Token refresh failed - notify renderer to show login
      sendToRenderer('auth-expired', { message: 'Session expired. Please log in again.' });
    }
  }

  return response;
}

// Helper function to fetch and store organization ID from profile if missing
// Deduplicated to prevent race conditions from concurrent calls
let orgIdPromise = null;

async function ensureOrganizationId() {
  let organizationId = store.get('organizationId');
  if (organizationId) return organizationId;

  // Deduplicate concurrent calls
  if (orgIdPromise) return orgIdPromise;

  orgIdPromise = (async () => {
    const serverUrl = store.get('serverUrl');
    const authToken = store.get('authToken');

    if (!serverUrl || !authToken) return null;

    try {
      const response = await fetchWithAuth(`${serverUrl}/api/profile/`, {
        method: 'GET'
      });

      if (response.ok) {
        const data = await response.json();
        if (data.organization_id) {
          store.set('organizationId', data.organization_id);
          store.set('organizationName', data.organization_name || '');
          if (logger) logger.info(`Fetched organization ID from profile: ${data.organization_id}`);
          return data.organization_id;
        }
      } else {
        if (logger) logger.error(`Profile fetch failed: ${response.status}`);
      }
    } catch (error) {
      if (logger) logger.error('Failed to fetch organization ID from profile:', error.message);
    }

    return null;
  })().finally(() => {
    orgIdPromise = null;
  });

  return orgIdPromise;
}

let mainWindow = null;
let tray = null;
let wsClient = null;
let tallyConnector = null;
let queueManager = null;
let isQuitting = false;

// Tray icon states
const TRAY_ICONS = {
  connected: 'tray-connected.png',
  disconnected: 'tray-disconnected.png',
  syncing: 'tray-syncing.png',
  error: 'tray-error.png'
};

// Current connection status
let connectionStatus = {
  server: false,
  tally: false,
  syncing: false
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    frame: true,
    show: false, // Don't show until ready
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Hide menu bar
  mainWindow.setMenuBarVisibility(false);

  // Maximize window when ready to show
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // Handle window close - minimize to tray instead
  mainWindow.on('close', (event) => {
    if (!isQuitting && store.get('minimizeToTray')) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    return true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '../../assets', TRAY_ICONS.disconnected);

  // Create a simple icon if file doesn't exist
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      trayIcon = createDefaultIcon();
    }
  } catch (e) {
    trayIcon = createDefaultIcon();
  }

  tray = new Tray(trayIcon);
  const appType = store.get('appType');
  const appLabel = appType === 'nexinvo-plus' ? 'NexInvo+' : 'NexInvo';
  tray.setToolTip(`Setu - ${appLabel} Tally Connector`);

  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createDefaultIcon() {
  // Create a simple 16x16 icon
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  // Fill with a blue color (RGBA)
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = 66;      // R
    canvas[i * 4 + 1] = 133; // G
    canvas[i * 4 + 2] = 244; // B
    canvas[i * 4 + 3] = 255; // A
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function updateTrayMenu() {
  const serverStatus = connectionStatus.server ? 'Connected' : 'Disconnected';
  const tallyStatus = connectionStatus.tally ? 'Connected' : 'Disconnected';

  const trayAppType = store.get('appType');
  const trayAppLabel = trayAppType === 'nexinvo-plus' ? 'NexInvo+' : 'NexInvo';
  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Setu - ${trayAppLabel} Connector`,
      enabled: false,
      icon: createDefaultIcon()
    },
    { type: 'separator' },
    {
      label: `Server: ${serverStatus}`,
      enabled: false
    },
    {
      label: `Tally: ${tallyStatus}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open Setu',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Check for Updates',
      click: () => {
        if (autoUpdater) autoUpdater.checkForUpdatesAndNotify();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Setu',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function updateTrayIcon() {
  if (!tray) return;

  let iconName = TRAY_ICONS.disconnected;
  let tooltip = 'Setu - Disconnected';

  if (connectionStatus.syncing) {
    iconName = TRAY_ICONS.syncing;
    tooltip = 'Setu - Syncing...';
  } else if (connectionStatus.server && connectionStatus.tally) {
    iconName = TRAY_ICONS.connected;
    tooltip = 'Setu - Connected';
  } else if (!connectionStatus.server || !connectionStatus.tally) {
    iconName = TRAY_ICONS.error;
    tooltip = `Setu - ${!connectionStatus.server ? 'Server' : 'Tally'} Disconnected`;
  }

  const iconPath = path.join(__dirname, '../../assets', iconName);
  try {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      tray.setImage(icon);
    }
  } catch (e) {
    // Use default icon on error
  }

  tray.setToolTip(tooltip);
  updateTrayMenu();
}

// Initialize services
async function initializeServices() {
  // Initialize Tally Connector
  tallyConnector = new TallyConnector({
    host: store.get('tallyHost'),
    port: store.get('tallyPort')
  });

  // Initialize Queue Manager
  queueManager = new QueueManager(store, tallyConnector);

  // Start Tally connection checker FIRST (sets global.checkTallyAndNotify)
  startTallyChecker();

  // Initialize WebSocket Client
  const serverUrl = store.get('serverUrl');
  const authToken = store.get('authToken');

  if (serverUrl && authToken) {
    // If we have valid credentials, consider server as connected
    // (auth token exists means REST API login was successful previously)
    connectionStatus.server = true;
    updateTrayIcon();

    // Convert HTTP URL to WebSocket URL for real-time updates
    const wsUrl = serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws/setu/';
    initWebSocket(wsUrl, authToken);
  }

  // Process any pending queue items
  queueManager.startProcessing();
}

function initWebSocket(serverUrl, authToken) {
  if (wsClient) {
    wsClient.disconnect();
  }

  wsClient = new WebSocketClient({
    serverUrl,
    authToken,
    onConnect: () => {
      connectionStatus.server = true;
      updateTrayIcon();
      sendToRenderer('server-status', { connected: true });
      logger.info('Connected to NexInvo server');

      // Send current Tally status to server after connection
      setTimeout(() => {
        if (global.checkTallyAndNotify) {
          global.checkTallyAndNotify();
        }
      }, 1000);
    },
    onDisconnect: () => {
      // Don't set connectionStatus.server = false here
      // WebSocket is optional - REST API connection is what matters
      // The server status is already set to true after successful login
      logger.info('WebSocket disconnected (REST API still available)');
    },
    onMessage: handleServerMessage,
    onError: (error) => {
      // Log WebSocket errors but don't notify user - WebSocket is optional
      logger.warn('WebSocket error (non-critical):', error.message || error);
    }
  });

  wsClient.connect();
}

async function handleServerMessage(message) {
  logger.info('Received message from server:', message.type);

  switch (message.type) {
    case 'SYNC_REQUEST':
      await handleSyncRequest(message.data);
      break;
    case 'CHECK_CONNECTION':
      await handleCheckConnection();
      break;
    case 'GET_LEDGERS':
      await handleGetLedgers(message.data);
      break;
    case 'GET_PARTIES':
      await handleGetParties(message.data);
      break;
    case 'GET_STOCK_ITEMS':
      await handleGetStockItems(message.data);
      break;
    case 'GET_SERVICE_LEDGERS':
      await handleGetServiceLedgers(message.data);
      break;
    case 'GET_SALES_VOUCHERS':
      await handleGetSalesVouchers(message.data);
      break;
    case 'PING':
      wsClient.send({ type: 'PONG', timestamp: Date.now() });
      break;
    default:
      logger.warn('Unknown message type:', message.type);
  }
}

async function handleSyncRequest(data) {
  connectionStatus.syncing = true;
  updateTrayIcon();
  sendToRenderer('sync-started', data);

  try {
    // Check if Tally is connected
    const tallyConnected = await tallyConnector.checkConnection();

    if (!tallyConnected) {
      // Add to offline queue
      queueManager.addToQueue({
        type: 'SYNC_INVOICES',
        data,
        timestamp: Date.now()
      });

      wsClient.send({
        type: 'SYNC_QUEUED',
        data: {
          requestId: data.requestId,
          message: 'Tally is offline. Request queued for later processing.'
        }
      });

      sendToRenderer('sync-queued', { message: 'Added to offline queue' });
      return;
    }

    // Process each invoice
    const results = {
      success: [],
      failed: [],
      requestId: data.requestId
    };

    for (const invoice of data.invoices) {
      try {
        const result = await tallyConnector.syncInvoice(invoice, data.mapping);
        results.success.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number
        });
        sendToRenderer('invoice-synced', { invoice: invoice.invoice_number });
      } catch (error) {
        results.failed.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number,
          error: error.message
        });
        logger.error(`Failed to sync invoice ${invoice.invoice_number}:`, error);
      }
    }

    // Send results back to server
    wsClient.send({
      type: 'SYNC_RESULT',
      data: results
    });

    sendToRenderer('sync-completed', results);
    store.set('lastSync', new Date().toISOString());

  } catch (error) {
    logger.error('Sync error:', error);
    wsClient.send({
      type: 'SYNC_ERROR',
      data: {
        requestId: data.requestId,
        error: error.message
      }
    });
    sendToRenderer('sync-error', { message: error.message });
  } finally {
    connectionStatus.syncing = false;
    updateTrayIcon();
  }
}

async function handleCheckConnection() {
  try {
    const result = await tallyConnector.checkConnection();
    wsClient.send({
      type: 'CONNECTION_STATUS',
      data: {
        connected: result.connected,
        companyName: result.companyName,
        tallyVersion: result.tallyVersion
      }
    });
  } catch (error) {
    wsClient.send({
      type: 'CONNECTION_STATUS',
      data: {
        connected: false,
        error: error.message
      }
    });
  }
}

async function handleGetLedgers(data = {}) {
  const requestId = data.request_id || data.requestId || '';
  logger.info(`Fetching ledgers from Tally (request_id: ${requestId})`);

  try {
    const ledgers = await tallyConnector.getLedgers();
    logger.info(`Fetched ${ledgers.length} ledgers from Tally`);
    wsClient.send({
      type: 'LEDGERS_RESPONSE',
      data: {
        ledgers,
        request_id: requestId
      }
    });
  } catch (error) {
    logger.error('Failed to fetch ledgers:', error.message);
    wsClient.send({
      type: 'LEDGERS_ERROR',
      data: {
        error: error.message,
        request_id: requestId
      }
    });
  }
}

async function handleGetParties(data = {}) {
  const requestId = data.request_id || data.requestId || '';
  logger.info(`Fetching parties from Tally (request_id: ${requestId})`);

  try {
    const parties = await tallyConnector.getParties();
    logger.info(`Fetched ${parties.length} parties from Tally`);
    wsClient.send({
      type: 'PARTIES_RESPONSE',
      data: {
        parties,
        request_id: requestId
      }
    });
  } catch (error) {
    logger.error('Failed to fetch parties:', error.message);
    wsClient.send({
      type: 'PARTIES_ERROR',
      data: {
        error: error.message,
        request_id: requestId
      }
    });
  }
}

async function handleGetStockItems(data = {}) {
  const requestId = data.request_id || data.requestId || '';
  logger.info(`Fetching stock items from Tally (request_id: ${requestId})`);

  try {
    const stockItems = await tallyConnector.getStockItems();
    logger.info(`Fetched ${stockItems.length} stock items from Tally`);
    wsClient.send({
      type: 'STOCK_ITEMS_RESPONSE',
      data: {
        stock_items: stockItems,
        request_id: requestId
      }
    });
  } catch (error) {
    logger.error('Failed to fetch stock items:', error.message);
    wsClient.send({
      type: 'STOCK_ITEMS_ERROR',
      data: {
        error: error.message,
        request_id: requestId
      }
    });
  }
}

async function handleGetServiceLedgers(data = {}) {
  const requestId = data.request_id || data.requestId || '';
  logger.info(`Fetching service ledgers from Tally (request_id: ${requestId})`);

  try {
    const serviceLedgers = await tallyConnector.getServiceLedgers();
    logger.info(`Fetched ${serviceLedgers.length} service ledgers from Tally`);
    wsClient.send({
      type: 'SERVICE_LEDGERS_RESPONSE',
      data: {
        service_ledgers: serviceLedgers,
        request_id: requestId
      }
    });
  } catch (error) {
    logger.error('Failed to fetch service ledgers:', error.message);
    wsClient.send({
      type: 'SERVICE_LEDGERS_ERROR',
      data: {
        error: error.message,
        request_id: requestId
      }
    });
  }
}

async function handleGetSalesVouchers(data = {}) {
  const requestId = data.request_id || data.requestId || '';
  const startDate = data.start_date || '';
  const endDate = data.end_date || '';
  logger.info(`Fetching sales vouchers from Tally (request_id: ${requestId}, ${startDate} to ${endDate})`);

  try {
    const vouchers = await tallyConnector.getSalesVouchers(startDate, endDate);
    logger.info(`Fetched ${vouchers.length} sales vouchers from Tally`);
    wsClient.send({
      type: 'SALES_VOUCHERS_RESPONSE',
      data: {
        vouchers: vouchers,
        request_id: requestId
      }
    });
  } catch (error) {
    logger.error('Failed to fetch sales vouchers:', error.message);
    wsClient.send({
      type: 'SALES_VOUCHERS_ERROR',
      data: {
        error: error.message,
        request_id: requestId
      }
    });
  }
}

function startTallyChecker() {
  // Check Tally connection every 30 seconds
  const checkTally = async (forceNotify = false) => {
    try {
      const result = await tallyConnector.checkConnection();
      const wasConnected = connectionStatus.tally;
      connectionStatus.tally = result.connected;

      const statusChanged = wasConnected !== result.connected;

      if (statusChanged) {
        updateTrayIcon();
        sendToRenderer('tally-status', {
          connected: result.connected,
          companyName: result.companyName,
          tallyVersion: result.tallyVersion
        });
      }

      // Notify server of status change OR if forced (e.g., after WebSocket reconnect)
      if ((statusChanged || forceNotify) && wsClient && wsClient.isConnected()) {
        wsClient.send({
          type: 'TALLY_STATUS',
          data: {
            connected: result.connected,
            companyName: result.companyName || ''
          }
        });
        logger.info(`Sent TALLY_STATUS to server: connected=${result.connected}, companyName=${result.companyName || ''}`);
      }

      // If Tally just connected, process queue
      if (result.connected && !wasConnected) {
        queueManager.processQueue();
      }
    } catch (error) {
      connectionStatus.tally = false;
      updateTrayIcon();
    }
  };

  // Store checkTally function globally so it can be called from WebSocket connect handler
  global.checkTallyAndNotify = () => checkTally(true);

  checkTally();
  setInterval(checkTally, 30000);
}

function sendToRenderer(channel, data) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}

// IPC Handlers
ipcMain.handle('get-config', () => {
  const user = store.get('user') || {};
  return {
    serverUrl: store.get('serverUrl'),
    authToken: store.get('authToken'),  // Include authToken so renderer can check login status
    appType: store.get('appType') || 'nexinvo',
    isDev: !app.isPackaged,
    tallyHost: store.get('tallyHost'),
    tallyPort: store.get('tallyPort'),
    autoStart: store.get('autoStart'),
    minimizeToTray: store.get('minimizeToTray'),
    lastSync: store.get('lastSync'),
    userEmail: user.email || ''
  };
});

ipcMain.handle('save-config', (event, config) => {
  Object.keys(config).forEach(key => {
    store.set(key, config[key]);
  });

  // Update Tally connector if host/port changed
  if (config.tallyHost || config.tallyPort) {
    tallyConnector.updateConfig({
      host: store.get('tallyHost'),
      port: store.get('tallyPort')
    });
  }

  return { success: true };
});

ipcMain.handle('login', async (event, { serverUrl, email, password, appType }) => {
  try {
    const axios = require('axios');
    // Remove trailing slash from serverUrl to prevent double slashes
    const cleanServerUrl = serverUrl.replace(/\/+$/, '');
    const response = await axios.post(`${cleanServerUrl}/api/token/`, {
      email,
      password,
      client_type: 'setu'  // Tell server this is Setu desktop connector
    }, {
      headers: {
        'User-Agent': 'Setu Desktop Connector/1.0'
      }
    });

    const { access, refresh, organization } = response.data;

    store.set('serverUrl', cleanServerUrl);
    store.set('authToken', access);
    store.set('refreshToken', refresh);
    store.set('appType', appType || 'nexinvo');
    store.set('user', { email }); // Store basic user info

    // Store organization ID for API calls that require it
    if (organization && organization.id) {
      store.set('organizationId', organization.id);
      store.set('organizationName', organization.name);
    }

    // Set server as connected immediately after successful login
    connectionStatus.server = true;
    updateTrayIcon();

    // Initialize WebSocket with new credentials (for real-time updates)
    initWebSocket(cleanServerUrl.replace('http', 'ws').replace('https', 'wss') + '/ws/setu/', access);

    return { success: true, user: { email } };
  } catch (error) {
    // Extract safe error message without circular references
    let errorMessage = error.message;
    if (error.response) {
      errorMessage = error.response.data?.detail ||
                    error.response.data?.error ||
                    error.response.statusText ||
                    `HTTP ${error.response.status}`;
    } else if (error.request) {
      errorMessage = 'No response from server. Please check your connection.';
    }

    logger.error('Login error:', errorMessage);

    return {
      success: false,
      error: errorMessage
    };
  }
});

ipcMain.handle('logout', () => {
  // Clear all authentication data - use clear() for complete reset
  store.delete('authToken');
  store.delete('refreshToken');
  store.delete('user');
  store.delete('serverUrl');
  store.delete('appType');
  store.delete('organizationId');
  store.delete('organizationName');
  store.delete('ledgerMappings');

  // Force write to disk
  store.set('_logoutTimestamp', Date.now());
  store.delete('_logoutTimestamp');

  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }

  connectionStatus.server = false;
  connectionStatus.tally = false;
  updateTrayIcon();

  // Notify renderer of disconnection
  sendToRenderer('server-status', { connected: false });
  sendToRenderer('tally-status', { connected: false, companyName: '', tallyVersion: '' });

  logger.info('User logged out - all auth data cleared');
  return { success: true };
});

ipcMain.handle('check-tally-connection', async () => {
  logger.info('=== IPC: check-tally-connection called ===');
  try {
    logger.info('Calling tallyConnector.checkConnection()...');
    const result = await tallyConnector.checkConnection();
    logger.info('checkConnection result: ' + JSON.stringify(result));
    connectionStatus.tally = result.connected;
    updateTrayIcon();
    return result;
  } catch (error) {
    logger.error('checkConnection error: ' + error.message);
    connectionStatus.tally = false;
    updateTrayIcon();
    return { connected: false, error: error.message };
  }
});

ipcMain.handle('get-tally-ledgers', async () => {
  try {
    const ledgers = await tallyConnector.getLedgers();
    return { success: true, ledgers };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-queue-status', () => {
  return queueManager.getStatus();
});

ipcMain.handle('clear-queue', () => {
  queueManager.clearQueue();
  return { success: true };
});

ipcMain.handle('get-connection-status', () => {
  return connectionStatus;
});

ipcMain.handle('get-logs', () => {
  return logger.getRecentLogs();
});

// ==========================================
// TALLY SYNC IPC HANDLERS
// ==========================================

// Fetch ledgers from Tally
ipcMain.handle('fetch-ledgers', async () => {
  try {
    const ledgers = await tallyConnector.getLedgers();
    return { success: true, ledgers };
  } catch (error) {
    logger.error('Failed to fetch ledgers:', error);
    return { success: false, error: error.message };
  }
});

// Get ledger mappings from server
ipcMain.handle('get-ledger-mappings', async () => {
  try {
    const serverUrl = store.get('serverUrl');

    if (!serverUrl) {
      throw new Error('Server URL not found. Please log in again.');
    }

    const organizationId = await ensureOrganizationId();
    if (!organizationId) {
      throw new Error('Organization ID not found. Please log out and log in again.');
    }

    const headers = getApiHeaders();
    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/mappings/`, {
      method: 'GET'
    });

    if (!response.ok) {
      const errText = await response.text();
      let errData = {};
      try {
        errData = JSON.parse(errText);
      } catch (e) {}
      throw new Error(errData.error || errData.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return { success: true, mappings: data.mappings };
  } catch (error) {
    logger.error('Failed to get ledger mappings:', error.message);
    return { success: false, error: error.message };
  }
});

// Save ledger mappings to server (with validation against Tally)
ipcMain.handle('save-ledger-mappings', async (event, mappings) => {
  try {
    const serverUrl = store.get('serverUrl');

    if (!serverUrl) {
      throw new Error('Server URL not found. Please log in again.');
    }

    const organizationId = await ensureOrganizationId();
    if (!organizationId) {
      throw new Error('Organization ID not found. Please log out and log in again.');
    }

    // Validate mapped ledgers exist in Tally
    const warnings = [];
    try {
      const tallyLedgers = await tallyConnector.getLedgers();
      const ledgerNames = new Set(tallyLedgers.map(l => l.name.toLowerCase()));

      const ledgerFields = [
        'salesLedger', 'cgstLedger', 'sgstLedger', 'igstLedger', 'roundOffLedger', 'discountLedger',
        'purchaseLedger', 'cgstInputLedger', 'sgstInputLedger', 'igstInputLedger', 'discountReceivedLedger',
        'bankLedger', 'cashLedger'
      ];
      for (const field of ledgerFields) {
        if (mappings[field] && !ledgerNames.has(mappings[field].toLowerCase())) {
          warnings.push(`${field}: "${mappings[field]}" not found in Tally`);
        }
      }
    } catch (error) {
      logger.warn('Could not validate mappings against Tally:', error.message);
    }

    logger.info(`Saving ledger mappings to server`);

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/mappings/`, {
      method: 'POST',
      body: JSON.stringify(mappings)
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`Save mappings error response: ${errText}`);
      let errData = {};
      try { errData = JSON.parse(errText); } catch (e) {}
      throw new Error(errData.error || errData.detail || `HTTP ${response.status}`);
    }

    logger.info('Ledger mappings saved successfully');
    return { success: true, warnings: warnings.length > 0 ? warnings : undefined };
  } catch (error) {
    logger.error('Failed to save ledger mappings:', error.message);
    return { success: false, error: error.message };
  }
});

// Sync invoices to Tally
ipcMain.handle('sync-invoices', async (event, { startDate, endDate, forceResync }) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-invoices/`, {
      method: 'POST',
      body: JSON.stringify({
        start_date: startDate,
        end_date: endDate,
        force_resync: forceResync
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to sync invoices');
    }

    const result = await response.json();
    store.set('lastSync', new Date().toISOString());
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to sync invoices:', error);
    return { success: false, error: error.message };
  }
});

// Fetch parties from Tally
ipcMain.handle('fetch-parties', async () => {
  try {
    const parties = await tallyConnector.getParties();
    return { success: true, parties };
  } catch (error) {
    logger.error('Failed to fetch parties:', error);
    return { success: false, error: error.message };
  }
});

// Fetch stock items from Tally
ipcMain.handle('fetch-stock-items', async () => {
  try {
    const stockItems = await tallyConnector.getStockItems();
    return { success: true, stockItems };
  } catch (error) {
    logger.error('Failed to fetch stock items:', error);
    return { success: false, error: error.message };
  }
});

// Fetch service ledgers from Tally (Sales Accounts)
ipcMain.handle('fetch-service-ledgers', async () => {
  try {
    const serviceLedgers = await tallyConnector.getServiceLedgers();
    return { success: true, serviceLedgers };
  } catch (error) {
    logger.error('Failed to fetch service ledgers:', error);
    return { success: false, error: error.message };
  }
});

// Fetch recent voucher numbers for prefix detection
ipcMain.handle('fetch-recent-voucher-numbers', async () => {
  try {
    const numbers = await tallyConnector.getRecentVoucherNumbers();
    return { success: true, voucherNumbers: numbers };
  } catch (error) {
    logger.error('Failed to fetch recent voucher numbers:', error);
    return { success: false, error: error.message };
  }
});

// Preview import clients
ipcMain.handle('preview-import-clients', async (event, parties) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/preview-clients/`, {
      method: 'POST',
      body: JSON.stringify({ parties })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to preview clients');
    }

    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to preview import clients:', error);
    return { success: false, error: error.message };
  }
});

// Preview import products
ipcMain.handle('preview-import-products', async (event, items) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/preview-products/`, {
      method: 'POST',
      body: JSON.stringify({ stock_items: items })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to preview products');
    }

    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to preview import products:', error);
    return { success: false, error: error.message };
  }
});

// Import clients
ipcMain.handle('import-clients', async (event, parties) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/import-clients/`, {
      method: 'POST',
      body: JSON.stringify({ parties })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to import clients');
    }

    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to import clients:', error);
    return { success: false, error: error.message };
  }
});

// Import products
ipcMain.handle('import-products', async (event, items) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/import-products/`, {
      method: 'POST',
      body: JSON.stringify({ stock_items: items })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to import products');
    }

    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to import products:', error);
    return { success: false, error: error.message };
  }
});

// Preview import services
ipcMain.handle('preview-import-services', async (event, items) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/preview-services/`, {
      method: 'POST',
      body: JSON.stringify({ stock_items: items })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to preview services');
    }

    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to preview import services:', error);
    return { success: false, error: error.message };
  }
});

// Import services
ipcMain.handle('import-services', async (event, items) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/import-services/`, {
      method: 'POST',
      body: JSON.stringify({ stock_items: items })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to import services');
    }

    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to import services:', error);
    return { success: false, error: error.message };
  }
});

// Fetch company details from Tally
ipcMain.handle('fetch-company-details', async () => {
  try {
    const companyDetails = await tallyConnector.getCompanyDetails();
    return { success: true, companyDetails };
  } catch (error) {
    logger.error('Failed to fetch company details:', error);
    return { success: false, error: error.message };
  }
});

// Sync company details to NexInvo
ipcMain.handle('sync-company-to-nexinvo', async (event, companyData) => {
  try {
    const serverUrl = store.get('serverUrl');

    const response = await fetchWithAuth(`${serverUrl}/api/settings/company/`, {
      method: 'PUT',
      body: JSON.stringify(companyData)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || 'Failed to update company settings');
    }

    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to sync company to NexInvo:', error);
    return { success: false, error: error.message };
  }
});

// ==========================================
// COMPLETE BOOKS IMPORT - Account Groups, Ledgers, Opening Balances, Vouchers
// ==========================================

// Fetch Account Groups hierarchy from Tally
ipcMain.handle('fetch-account-groups', async () => {
  try {
    const groups = await tallyConnector.getAccountGroups();
    return { success: true, groups };
  } catch (error) {
    logger.error('Failed to fetch account groups:', error);
    return { success: false, error: error.message };
  }
});

// Fetch all Ledgers with Opening Balances from Tally
ipcMain.handle('fetch-ledgers-with-balances', async () => {
  try {
    const ledgers = await tallyConnector.getLedgersWithOpeningBalances();
    return { success: true, ledgers };
  } catch (error) {
    logger.error('Failed to fetch ledgers with balances:', error);
    return { success: false, error: error.message };
  }
});

// Fetch all Vouchers (all types) from Tally for a date range
ipcMain.handle('fetch-all-vouchers', async (event, { startDate, endDate }) => {
  try {
    const vouchers = await tallyConnector.getAllVouchers(startDate, endDate);
    return { success: true, vouchers };
  } catch (error) {
    logger.error('Failed to fetch all vouchers:', error);
    return { success: false, error: error.message };
  }
});

// Import Account Groups to NexInvo+
ipcMain.handle('import-account-groups', async (event, groups) => {
  try {
    const serverUrl = store.get('serverUrl');
    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/import-account-groups/`, {
      method: 'POST',
      body: JSON.stringify({ groups })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || 'Failed to import account groups');
    }
    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to import account groups:', error);
    return { success: false, error: error.message };
  }
});

// Import Ledger Accounts to NexInvo+
ipcMain.handle('import-ledger-accounts', async (event, ledgers) => {
  try {
    const serverUrl = store.get('serverUrl');
    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/import-ledger-accounts/`, {
      method: 'POST',
      body: JSON.stringify({ ledgers })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || 'Failed to import ledger accounts');
    }
    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to import ledger accounts:', error);
    return { success: false, error: error.message };
  }
});

// Import Opening Balances to NexInvo+
ipcMain.handle('import-opening-balances', async (event, balances) => {
  try {
    const serverUrl = store.get('serverUrl');
    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/import-opening-balances/`, {
      method: 'POST',
      body: JSON.stringify({ balances })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || 'Failed to import opening balances');
    }
    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to import opening balances:', error);
    return { success: false, error: error.message };
  }
});

// Preview Import Vouchers to NexInvo+
ipcMain.handle('preview-import-vouchers', async (event, params) => {
  try {
    const serverUrl = store.get('serverUrl');
    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/preview-import-vouchers/`, {
      method: 'POST',
      body: JSON.stringify(params)
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || 'Failed to preview vouchers');
    }
    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to preview import vouchers:', error);
    return { success: false, error: error.message };
  }
});

// Import Vouchers to NexInvo+
ipcMain.handle('import-vouchers', async (event, params) => {
  try {
    const serverUrl = store.get('serverUrl');
    const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/import-vouchers/`, {
      method: 'POST',
      body: JSON.stringify(params)
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || 'Failed to import vouchers');
    }
    const result = await response.json();
    return { success: true, ...result };
  } catch (error) {
    logger.error('Failed to import vouchers:', error);
    return { success: false, error: error.message };
  }
});

// Helper function to get Indian Financial Year start date (April 1st)
function getIndianFinancialYearStart() {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth(); // 0-indexed, so April = 3

  // If current month is before April (Jan-Mar), FY started last year
  // If current month is April or later, FY started this year
  const fyStartYear = currentMonth < 3 ? currentYear - 1 : currentYear;

  return new Date(fyStartYear, 3, 1); // April 1st (month is 0-indexed)
}

// Real-time sync - performs automatic two-way sync
ipcMain.handle('perform-realtime-sync', async () => {
  try {
    const serverUrl = store.get('serverUrl');
    const authToken = store.get('authToken');

    if (!serverUrl || !authToken) {
      throw new Error('Not logged in');
    }

    // Read auto-sync config for sync mode and voucher types
    const autoSyncConfig = store.get('autoSyncConfig') || {};
    const syncMode = autoSyncConfig.syncMode || 'invoices';
    const voucherTypes = autoSyncConfig.voucherTypes || [];

    // Determine start date based on last sync or financial year
    const endDate = new Date().toISOString().split('T')[0];
    let startDate;
    let isFirstSync = false;

    // Check for last successful real-time sync date
    const lastRealtimeSync = store.get('lastRealtimeSync');

    if (lastRealtimeSync) {
      // Use last sync date as start (go back 1 day to catch any edge cases)
      const lastSyncDate = new Date(lastRealtimeSync);
      lastSyncDate.setDate(lastSyncDate.getDate() - 1);
      startDate = lastSyncDate.toISOString().split('T')[0];
      logger.info(`Real-time sync: Using last sync date ${lastRealtimeSync}, fetching from ${startDate}`);
    } else {
      // First sync - use Indian Financial Year start (April 1st)
      isFirstSync = true;
      const fyStart = getIndianFinancialYearStart();
      startDate = fyStart.toISOString().split('T')[0];
      logger.info(`Real-time sync: First sync, using FY start date ${startDate}`);
    }

    logger.info(`Real-time sync mode: ${syncMode}`);

    // ===== Full Books mode (Voucher-level two-way sync) =====
    if (syncMode === 'vouchers') {
      // Fetch vouchers from Tally (filtered by selected types or all)
      let tallyVouchers = [];
      try {
        if (voucherTypes.length > 0) {
          tallyVouchers = await tallyConnector.getVouchersByTypes(startDate, endDate, voucherTypes);
        } else {
          tallyVouchers = await tallyConnector.getAllVouchers(startDate, endDate);
        }
        logger.info(`Fetched ${tallyVouchers.length} vouchers from Tally (full books, ${startDate} to ${endDate})`);
      } catch (tallyError) {
        logger.warn('Could not fetch Tally vouchers:', tallyError.message);
      }

      // Compare against Voucher model
      const previewResponse = await fetchWithAuth(`${serverUrl}/api/tally-sync/two-way-voucher-preview/`, {
        method: 'POST',
        body: JSON.stringify({
          tally_vouchers: tallyVouchers,
          start_date: startDate,
          end_date: endDate,
          voucher_types: voucherTypes
        })
      });

      if (!previewResponse.ok) {
        const errData = await previewResponse.json().catch(() => ({}));
        logger.error('Voucher preview API failed:', errData);
        throw new Error(errData.error || 'Failed to compare vouchers');
      }

      const previewResult = await previewResponse.json();
      const toTally = previewResult.to_tally || [];
      const toNexinvo = previewResult.to_nexinvo || [];
      const matched = previewResult.matched || [];

      logger.info(`Voucher preview: ${toTally.length} to Tally, ${toNexinvo.length} to NexInvo, ${matched.length} matched`);

      let toTallyCount = 0;
      let toNexinvoCount = 0;
      let errorsCount = 0;

      // Sync NexInvo vouchers to Tally via Tally Connector
      if (toTally.length > 0) {
        const syncedIds = [];
        for (const voucher of toTally) {
          try {
            const tallyVoucher = {
              voucher_type_display: voucher.voucher_type_display || voucher.voucher_type,
              voucher_number: voucher.voucher_number,
              voucher_date: voucher.date || voucher.voucher_date,
              party_ledger_name: voucher.party_name || voucher.party_ledger_name || '',
              narration: voucher.narration || '',
              entries: voucher.entries || []
            };
            await tallyConnector.syncVoucher(tallyVoucher);
            syncedIds.push(voucher.id);
            toTallyCount++;
          } catch (err) {
            logger.error(`Error syncing voucher ${voucher.voucher_number} to Tally:`, err.message);
            errorsCount++;
          }
        }
        // Mark synced in NexInvo
        if (syncedIds.length > 0) {
          try {
            await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-vouchers-to-tally/`, {
              method: 'POST',
              body: JSON.stringify({ voucher_ids: syncedIds })
            });
          } catch (err) {
            logger.error('Error marking vouchers as synced:', err.message);
          }
        }
      }

      // Sync Tally vouchers to NexInvo
      if (toNexinvo.length > 0) {
        try {
          const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-vouchers-to-nexinvo/`, {
            method: 'POST',
            body: JSON.stringify({ vouchers: toNexinvo, force_sync: false, auto_create_ledgers: true })
          });
          if (response.ok) {
            const result = await response.json();
            toNexinvoCount = result.created_count || 0;
            errorsCount += (result.failed_count || 0);
          } else {
            errorsCount += toNexinvo.length;
          }
        } catch (error) {
          logger.error('Error syncing vouchers to NexInvo:', error);
          errorsCount += toNexinvo.length;
        }
      }

      // Save successful sync timestamp
      const syncTimestamp = new Date().toISOString();
      store.set('lastRealtimeSync', syncTimestamp);

      logger.info(`Real-time sync (full books) completed: ${toTallyCount} to Tally, ${toNexinvoCount} to NexInvo, ${matched.length} matched`);

      return {
        success: true,
        syncMode: 'vouchers',
        to_tally_count: toTallyCount,
        to_nexinvo_count: toNexinvoCount,
        matched_count: matched.length,
        errors_count: errorsCount,
        is_first_sync: isFirstSync,
        sync_period: { start: startDate, end: endDate },
        preview_to_tally: toTally.length,
        preview_to_nexinvo: toNexinvo.length,
        tally_vouchers_fetched: tallyVouchers.length
      };
    }

    // ===== Invoice mode (default — backward compatible) =====
    // First fetch sales vouchers from Tally
    let tallyVouchers = [];
    try {
      tallyVouchers = await tallyConnector.getSalesVouchers(startDate, endDate);
      logger.info(`Fetched ${tallyVouchers.length} vouchers from Tally (${startDate} to ${endDate})`);
    } catch (tallyError) {
      logger.warn('Could not fetch Tally vouchers:', tallyError.message);
      // Continue with empty tally vouchers - will only sync NexInvo to Tally
    }

    // Compare with NexInvo to find what needs syncing
    logger.info(`Sending preview request to ${serverUrl}/api/tally-sync/two-way-preview/ with ${tallyVouchers.length} Tally vouchers`);
    const previewResponse = await fetchWithAuth(`${serverUrl}/api/tally-sync/two-way-preview/`, {
      method: 'POST',
      body: JSON.stringify({
        tally_vouchers: tallyVouchers,
        start_date: startDate,
        end_date: endDate
      })
    });

    if (!previewResponse.ok) {
      const errData = await previewResponse.json().catch(() => ({}));
      logger.error('Preview API failed:', errData);
      throw new Error(errData.error || 'Failed to compare invoices');
    }

    const previewResult = await previewResponse.json();
    const toTally = previewResult.to_tally || [];
    const toNexinvo = previewResult.to_nexinvo || [];
    const matched = previewResult.matched || [];

    logger.info(`Preview results: ${toTally.length} to Tally, ${toNexinvo.length} to NexInvo, ${matched.length} matched`);

    let toTallyCount = 0;
    let toNexinvoCount = 0;
    let errorsCount = 0;

    // Sync NexInvo invoices to Tally (auto-select all unsynced)
    if (toTally.length > 0) {
      try {
        const invoiceIds = toTally.map(inv => inv.id);
        const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-invoices/`, {
          method: 'POST',
          body: JSON.stringify({ invoice_ids: invoiceIds })
        });

        if (response.ok) {
          const result = await response.json();
          toTallyCount = result.success_count || 0;
          errorsCount += (result.failed_count || 0);
        } else {
          errorsCount += toTally.length;
        }
      } catch (error) {
        logger.error('Error syncing to Tally:', error);
        errorsCount += toTally.length;
      }
    }

    // Sync Tally vouchers to NexInvo (auto-import all missing)
    if (toNexinvo.length > 0) {
      try {
        const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-to-nexinvo/`, {
          method: 'POST',
          body: JSON.stringify({ vouchers: toNexinvo })
        });

        if (response.ok) {
          const result = await response.json();
          toNexinvoCount = result.created_count || 0;
          errorsCount += (result.failed_count || 0);
        } else {
          errorsCount += toNexinvo.length;
        }
      } catch (error) {
        logger.error('Error syncing to NexInvo:', error);
        errorsCount += toNexinvo.length;
      }
    }

    // Save successful sync timestamp
    const syncTimestamp = new Date().toISOString();
    store.set('lastRealtimeSync', syncTimestamp);

    logger.info(`Real-time sync completed: ${toTallyCount} to Tally, ${toNexinvoCount} to NexInvo, ${matched.length} matched`);

    return {
      success: true,
      syncMode: 'invoices',
      to_tally_count: toTallyCount,
      to_nexinvo_count: toNexinvoCount,
      matched_count: matched.length,
      errors_count: errorsCount,
      is_first_sync: isFirstSync,
      sync_period: { start: startDate, end: endDate },
      // Include preview counts for debugging
      preview_to_tally: toTally.length,
      preview_to_nexinvo: toNexinvo.length,
      tally_vouchers_fetched: tallyVouchers.length
    };
  } catch (error) {
    logger.error('Failed to perform real-time sync:', error);
    return { success: false, error: error.message };
  }
});

// Auto Sync Config - Save sync mode and voucher type preferences
ipcMain.handle('save-auto-sync-config', async (event, config) => {
  try {
    // config: { syncMode: 'invoices'|'vouchers', voucherTypes: [...] }
    store.set('autoSyncConfig', config);
    logger.info('Auto sync config saved:', JSON.stringify(config));
    return { success: true };
  } catch (error) {
    logger.error('Failed to save auto sync config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-auto-sync-config', async () => {
  try {
    const config = store.get('autoSyncConfig') || { syncMode: 'invoices', voucherTypes: [] };
    return { success: true, config };
  } catch (error) {
    logger.error('Failed to get auto sync config:', error);
    return { success: false, config: { syncMode: 'invoices', voucherTypes: [] } };
  }
});

// Manual Sync Preview - Get comparison of invoices between Tally and NexInvo
ipcMain.handle('get-manual-sync-preview', async (event, { startDate, endDate, syncMode, voucherTypes }) => {
  try {
    const serverUrl = store.get('serverUrl');
    const authToken = store.get('authToken');

    if (!serverUrl || !authToken) {
      throw new Error('Not logged in');
    }

    if (!startDate || !endDate) {
      throw new Error('Start date and end date are required');
    }

    // Full Books mode: use Voucher-level comparison
    if (syncMode === 'vouchers') {
      logger.info(`Manual sync preview (Full Books): ${startDate} to ${endDate}, types: ${(voucherTypes || []).join(', ')}`);

      let tallyVouchers = [];
      try {
        if (voucherTypes && voucherTypes.length > 0) {
          tallyVouchers = await tallyConnector.getVouchersByTypes(startDate, endDate, voucherTypes);
        } else {
          tallyVouchers = await tallyConnector.getAllVouchers(startDate, endDate);
        }
        logger.info(`Fetched ${tallyVouchers.length} vouchers from Tally (full books)`);
      } catch (tallyError) {
        logger.warn('Could not fetch Tally vouchers:', tallyError.message);
      }

      const previewResponse = await fetchWithAuth(`${serverUrl}/api/tally-sync/two-way-voucher-preview/`, {
        method: 'POST',
        body: JSON.stringify({
          tally_vouchers: tallyVouchers,
          start_date: startDate,
          end_date: endDate,
          voucher_types: voucherTypes || []
        })
      });

      if (!previewResponse.ok) {
        const errData = await previewResponse.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to compare vouchers');
      }

      const previewResult = await previewResponse.json();
      return {
        success: true,
        syncMode: 'vouchers',
        to_tally: previewResult.to_tally || [],
        to_nexinvo: previewResult.to_nexinvo || [],
        matched: previewResult.matched || []
      };
    }

    // Invoice mode (default / backward compat)
    logger.info(`Manual sync preview (Invoices): ${startDate} to ${endDate}`);

    let tallyVouchers = [];
    try {
      tallyVouchers = await tallyConnector.getSalesVouchers(startDate, endDate);
      logger.info(`Fetched ${tallyVouchers.length} vouchers from Tally`);
    } catch (tallyError) {
      logger.warn('Could not fetch Tally vouchers:', tallyError.message);
    }

    const previewResponse = await fetchWithAuth(`${serverUrl}/api/tally-sync/two-way-preview/`, {
      method: 'POST',
      body: JSON.stringify({
        tally_vouchers: tallyVouchers,
        start_date: startDate,
        end_date: endDate
      })
    });

    if (!previewResponse.ok) {
      const errData = await previewResponse.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to compare invoices');
    }

    const previewResult = await previewResponse.json();

    return {
      success: true,
      syncMode: 'invoices',
      to_tally: previewResult.to_tally || [],
      to_nexinvo: previewResult.to_nexinvo || [],
      matched: previewResult.matched || []
    };
  } catch (error) {
    logger.error('Failed to get manual sync preview:', error);
    return { success: false, error: error.message };
  }
});

// Execute Manual Sync - Sync selected invoices/vouchers
ipcMain.handle('execute-manual-sync', async (event, { toTallyIds, toTallyVouchers, toNexinvoVouchers, syncMode }) => {
  try {
    const serverUrl = store.get('serverUrl');
    const authToken = store.get('authToken');

    if (!serverUrl || !authToken) {
      throw new Error('Not logged in');
    }

    let toTallyCount = 0;
    let toNexinvoCount = 0;
    let errorsCount = 0;
    const errors = [];

    // ========== FULL BOOKS MODE (Voucher-level) ==========
    if (syncMode === 'vouchers') {
      // NexInvo Vouchers → Tally: post each via tally-connector
      if (toTallyVouchers && toTallyVouchers.length > 0) {
        logger.info(`Syncing ${toTallyVouchers.length} vouchers to Tally (full books)`);
        const syncedIds = [];
        for (const voucher of toTallyVouchers) {
          try {
            await tallyConnector.syncVoucher(voucher);
            syncedIds.push(voucher.id);
            toTallyCount++;
          } catch (error) {
            errorsCount++;
            errors.push(`Voucher ${voucher.voucher_number}: ${error.message}`);
          }
        }
        // Mark as synced on backend
        if (syncedIds.length > 0) {
          try {
            await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-vouchers-to-tally/`, {
              method: 'POST',
              body: JSON.stringify({ voucher_ids: syncedIds })
            });
          } catch (e) {
            logger.warn('Could not mark vouchers as synced:', e.message);
          }
        }
      }

      // Tally → NexInvo: import as Voucher+VoucherEntry
      if (toNexinvoVouchers && toNexinvoVouchers.length > 0) {
        try {
          logger.info(`Syncing ${toNexinvoVouchers.length} vouchers to NexInvo (full books, force_sync=true)`);
          const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-vouchers-to-nexinvo/`, {
            method: 'POST',
            body: JSON.stringify({ vouchers: toNexinvoVouchers, force_sync: true, auto_create_ledgers: true })
          });

          if (response.ok) {
            const result = await response.json();
            toNexinvoCount = result.created_count || 0;
            if (result.errors && result.errors.length > 0) errors.push(...result.errors);
          } else {
            const errData = await response.json().catch(() => ({}));
            errorsCount += toNexinvoVouchers.length;
            errors.push(errData.error || 'Failed to sync vouchers to NexInvo');
          }
        } catch (error) {
          logger.error('Error syncing vouchers to NexInvo:', error);
          errorsCount += toNexinvoVouchers.length;
          errors.push(error.message);
        }
      }
    } else {
      // ========== INVOICE MODE (default / backward compat) ==========
      // Sync selected NexInvo invoices to Tally
      if (toTallyIds && toTallyIds.length > 0) {
        try {
          logger.info(`Syncing ${toTallyIds.length} invoices to Tally`);
          const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-invoices/`, {
            method: 'POST',
            body: JSON.stringify({ invoice_ids: toTallyIds })
          });

          if (response.ok) {
            const result = await response.json();
            toTallyCount = result.success_count || 0;
            errorsCount += (result.failed_count || 0);
            if (result.errors) errors.push(...result.errors);
          } else {
            const errData = await response.json().catch(() => ({}));
            errorsCount += toTallyIds.length;
            errors.push(errData.error || 'Failed to sync to Tally');
          }
        } catch (error) {
          logger.error('Error syncing to Tally:', error);
          errorsCount += toTallyIds.length;
          errors.push(error.message);
        }
      }

      // Sync selected Tally vouchers to NexInvo (Invoice model)
      if (toNexinvoVouchers && toNexinvoVouchers.length > 0) {
        try {
          logger.info(`Syncing ${toNexinvoVouchers.length} vouchers to NexInvo (force_sync=true)`);
          const response = await fetchWithAuth(`${serverUrl}/api/tally-sync/sync-to-nexinvo/`, {
            method: 'POST',
            body: JSON.stringify({ vouchers: toNexinvoVouchers, force_sync: true })
          });

          if (response.ok) {
            const result = await response.json();
            toNexinvoCount = result.created_count || 0;
            errorsCount += (result.failed_count || 0);
            errorsCount += (result.skipped_count || 0);
            if (result.errors && result.errors.length > 0) errors.push(...result.errors);
            if (result.skipped_count > 0) {
              errors.push(`${result.skipped_count} skipped (${result.matched_count || 0} matched by date/amount/client)`);
            }
          } else {
            const errData = await response.json().catch(() => ({}));
            errorsCount += toNexinvoVouchers.length;
            errors.push(errData.error || 'Failed to sync to NexInvo');
          }
        } catch (error) {
          logger.error('Error syncing to NexInvo:', error);
          errorsCount += toNexinvoVouchers.length;
          errors.push(error.message);
        }
      }
    }

    // Update last sync timestamp on success
    if (toTallyCount > 0 || toNexinvoCount > 0) {
      store.set('lastSync', new Date().toISOString());
    }

    logger.info(`Manual sync completed: ${toTallyCount} to Tally, ${toNexinvoCount} to NexInvo, ${errorsCount} errors`);

    return {
      success: true,
      to_tally_count: toTallyCount,
      to_nexinvo_count: toNexinvoCount,
      errors_count: errorsCount,
      errors: errors
    };
  } catch (error) {
    logger.error('Failed to execute manual sync:', error);
    return { success: false, error: error.message };
  }
});

// Auto-updater events - setup function to be called after modules are loaded
function setupAutoUpdater() {
  if (!autoUpdater) return;
  
  autoUpdater.on('checking-for-update', () => {
    sendToRenderer('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('update-status', { status: 'available', info });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendToRenderer('update-status', { status: 'not-available', info });
  });

  autoUpdater.on('error', (err) => {
    sendToRenderer('update-status', { status: 'error', error: err.message });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update-status', { status: 'downloading', progress });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('update-status', { status: 'downloaded', info });
  });
}

ipcMain.handle('install-update', () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

ipcMain.handle('check-for-updates', () => {
  if (autoUpdater) autoUpdater.checkForUpdatesAndNotify();
});

// App lifecycle
app.whenReady().then(() => {
  // Load modules now that app is ready
  loadModules();

  // Test log to confirm logger is working
  logger.info('=== Setu Application Started ===');
  logger.info('Logger initialized successfully');

  // Setup auto-updater events
  setupAutoUpdater();
  
  createWindow();
  createTray();
  initializeServices();

  // Check for updates on startup
  if (process.env.NODE_ENV !== 'development' && autoUpdater) {
    autoUpdater.checkForUpdatesAndNotify();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit, keep running in tray
  }
});

app.on('before-quit', () => {
  isQuitting = true;

  if (wsClient) {
    wsClient.disconnect();
  }
});

// Handle single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
