const fs = require('fs');
const path = require('path');
const os = require('os');

// Get log path
let logPath = path.join(os.tmpdir(), 'setu-logs');

try {
  const { app } = require('electron');
  if (app && app.isReady && app.isReady()) {
    logPath = path.join(app.getPath('userData'), 'logs');
  }
} catch (e) {
  // Electron not available
}

// Ensure log directory exists
try {
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(logPath, { recursive: true });
  }
} catch (e) {
  logPath = os.tmpdir();
}

const logFile = path.join(logPath, 'setu.log');

// Log rotation settings
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_LOG_FILES = 3; // Keep setu.log, setu.1.log, setu.2.log

// In-memory log storage for UI display
const recentLogs = [];
const MAX_RECENT_LOGS = 100;

// Check and rotate log file if needed
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(logFile)) return;

    const stats = fs.statSync(logFile);
    if (stats.size < MAX_LOG_SIZE) return;

    // Rotate: delete oldest, shift others
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const older = path.join(logPath, `setu.${i}.log`);
      const newer = i === 1 ? logFile : path.join(logPath, `setu.${i - 1}.log`);

      if (i === MAX_LOG_FILES - 1 && fs.existsSync(older)) {
        fs.unlinkSync(older);
      }
      if (fs.existsSync(newer)) {
        fs.renameSync(newer, older);
      }
    }
  } catch (e) {
    // Silently ignore rotation errors
  }
}

// Track writes for periodic rotation check
let writeCount = 0;

// Simple file logger - NO console output to avoid EPIPE
function writeToFile(level, message) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} [${level.toUpperCase()}] ${message}\n`;

  try {
    // Check rotation every 100 writes
    if (++writeCount >= 100) {
      writeCount = 0;
      rotateIfNeeded();
    }

    fs.appendFileSync(logFile, logLine);
  } catch (e) {
    // Silently ignore file write errors
  }
}

function addToMemory(level, message) {
  recentLogs.unshift({
    timestamp: new Date().toISOString(),
    level: level,
    message: String(message)
  });

  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.pop();
  }
}

// Logger object
const logger = {
  info: (message, ...args) => {
    const msg = args.length ? `${message} ${args.join(' ')}` : String(message);
    addToMemory('info', msg);
    writeToFile('info', msg);
  },

  warn: (message, ...args) => {
    const msg = args.length ? `${message} ${args.join(' ')}` : String(message);
    addToMemory('warn', msg);
    writeToFile('warn', msg);
  },

  error: (message, ...args) => {
    const msg = args.length ? `${message} ${args.join(' ')}` : String(message);
    addToMemory('error', msg);
    writeToFile('error', msg);
  },

  debug: (message, ...args) => {
    const msg = args.length ? `${message} ${args.join(' ')}` : String(message);
    addToMemory('debug', msg);
    writeToFile('debug', msg);
  },

  getRecentLogs: () => [...recentLogs],

  clearRecentLogs: () => {
    recentLogs.length = 0;
  }
};

module.exports = logger;
