# Setu - NexInvo Tally Connector Setup Guide

## Overview
Setu is a desktop connector application that bridges your NexInvo web application with Tally running on your local computer. It enables seamless synchronization of invoices and other data between the cloud-based NexInvo and locally-installed Tally.

## Prerequisites

1. **Node.js** - The app has been tested with Node.js v20+
2. **Tally Prime/ERP 9** - Must be running locally with ODBC server enabled on port 9000
3. **NexInvo Server** - Your NexInvo backend must be running with WebSocket support

## Installation

```bash
cd Setu
npm install
```

## Running the Application

### Development Mode
```bash
npm start
```

Or:
```bash
npm run dev
```

### Building for Production
```bash
# Build for Windows
npm run build:win

# Or build for all platforms
npm run build
```

## Important: VS Code / Electron IDE Users

If you're running this from VS Code (or any Electron-based IDE), the `start.js` wrapper script is crucial. It removes the `ELECTRON_RUN_AS_NODE` environment variable that these IDEs set, which would otherwise prevent Electron from running correctly.

**Do not modify or remove `start.js`** unless you're running from a non-Electron terminal.

## Configuration

### First Run

1. **Launch the App**: Run `npm start`
2. **Login Tab**:
   - Enter your NexInvo server URL (e.g., `http://localhost:8000` or your hosted URL)
   - Enter your email and password
   - Click "Login"

3. **Settings Tab**:
   - Tally Host: Usually `localhost`
   - Tally Port: Usually `9000` (default Tally ODBC port)
   - Auto-start with system (optional)
   - Minimize to tray on close (optional)

### Tally Configuration

1. Enable Tally's ODBC Server:
   - Open Tally
   - Go to Gateway of Tally → F11: Features → Company Operations
   - Enable "Provide data to ODBC" or similar option
   - Configure port (default: 9000)
   - Set appropriate permissions

## Features

### System Tray
- The app runs in the system tray
- Tray icon changes based on connection status:
  - **Blue**: Disconnected
  - **Green**: Connected to both server and Tally
  - **Orange**: Syncing
  - **Red**: Connection error

### Tabs

1. **Login**: Connect to your NexInvo server
2. **Status**: View real-time connection status for server and Tally
3. **Settings**: Configure Tally connection and app preferences
4. **Queue**: View pending sync operations (when Tally is offline)
5. **Logs**: View application logs for debugging

### Auto-Update
The app includes automatic update functionality (works only with packaged/distributed versions).

## Offline Queue
When Tally is offline, sync requests are queued automatically. Once Tally comes back online, the queue is processed automatically.

## Troubleshooting

### App won't start / "Cannot read properties of undefined"
- Make sure you're using the npm scripts (`npm start`) rather than running electron directly
- The `start.js` wrapper handles environment issues

### Can't connect to Tally
- Verify Tally is running
- Check that ODBC server is enabled in Tally
- Confirm the port number (default: 9000)
- Check firewall settings

### Can't connect to NexInvo server
- Verify the server URL is correct (include protocol: http:// or https://)
- Ensure the server is running and accessible
- Check that Django Channels and WebSocket routing are configured
- Verify your credentials are correct

### GPU cache errors on startup
These are harmless Chromium cache warnings and don't affect functionality. They can be safely ignored.

## Architecture

- **Electron 33** - Desktop app framework
- **WebSocket** - Real-time communication with NexInvo server
- **XML/HTTP** - Communication with Tally ODBC server
- **electron-store** - Persistent configuration storage
- **electron-updater** - Automatic updates

## Development Notes

### File Structure
```
Setu/
├── src/
│   ├── main/
│   │   ├── main.js         # Main Electron process
│   │   ├── preload.js      # Preload script for IPC
│   │   └── logger.js       # Logging utility
│   ├── services/
│   │   ├── websocket-client.js   # WebSocket connection handler
│   │   ├── tally-connector.js    # Tally XML/HTTP client
│   │   └── queue-manager.js      # Offline queue management
│   └── renderer/
│       ├── index.html      # UI
│       ├── styles.css      # Styles
│       └── renderer.js     # Frontend logic
├── assets/                 # Icons and resources
├── start.js               # Wrapper script (handles ELECTRON_RUN_AS_NODE)
└── package.json           # Project configuration
```

### Adding Features

1. **New IPC Handlers**: Add to `src/main/main.js` using `ipcMain.handle()`
2. **New UI**: Update `src/renderer/index.html` and `renderer.js`
3. **New WebSocket Messages**: Add handlers in `handleServerMessage()` function

## Backend Integration

Ensure your NexInvo backend has:

1. **Django Channels** installed and configured
2. **WebSocket Consumer**: `api/setu_consumer.py`
3. **Setu Views**: `api/setu_views.py`
4. **URL Routing**: WebSocket route at `/ws/setu/`
5. **ASGI Configuration**: Proper ProtocolTypeRouter setup

## License
MIT

## Support
For issues or questions, contact NexInvo support or refer to the main NexInvo documentation.
