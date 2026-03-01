# Setu - NexInvo Tally Connector

Setu is a desktop application that bridges your NexInvo web application with Tally accounting software running on your local computer.

## Why Setu?

NexInvo is a web-based invoice management system. Tally (Prime/ERP 9) runs locally on your Windows computer. Since a web server cannot directly access your local Tally instance, Setu acts as a secure bridge between them.

```
NexInvo (Cloud)  <-->  Setu (Your PC)  <-->  Tally (Your PC)
```

## Features

- **System Tray App**: Runs quietly in the background
- **Real-time Sync**: Instantly receive sync requests from NexInvo
- **Offline Queue**: Queues requests when Tally is offline, processes when available
- **Auto-Update**: Automatically updates to the latest version
- **Secure**: Uses JWT authentication and WebSocket for secure communication

## Requirements

- Windows 10 or later
- Tally Prime or Tally ERP 9
- Active NexInvo account
- Internet connection

## Tally Configuration

Before using Setu, configure Tally to accept connections:

1. Open Tally Prime/ERP 9
2. Go to **F12 (Configure)** > **Connectivity**
3. Set **Enable ODBC Server** to **Yes**
4. Note the port (default: 9000)
5. Ensure a company is open

## Installation

### Option 1: Download Installer (Recommended)
1. Download the latest `Setu-Setup-x.x.x.exe` from releases
2. Run the installer
3. Follow the installation wizard
4. Setu will start automatically

### Option 2: Build from Source
```bash
# Clone the repository
cd Setu

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build:win
```

## Usage

### First-time Setup

1. Launch Setu from Start Menu or Desktop
2. Enter your NexInvo server URL (e.g., `https://app.nexinvo.com`)
3. Login with your NexInvo credentials
4. Configure Tally connection settings (if different from default)
5. Click "Check Tally Connection" to verify

### Daily Usage

1. Start Tally and open your company
2. Setu runs in the system tray (near the clock)
3. Use NexInvo web app normally
4. When you trigger a Tally sync from NexInvo, Setu handles it automatically

### Status Indicators

| Icon Color | Meaning |
|------------|---------|
| Green | Both server and Tally connected |
| Yellow | Syncing in progress |
| Red | Disconnected (server or Tally) |

## Troubleshooting

### Tally Connection Failed
- Ensure Tally is running with a company open
- Check ODBC Server is enabled (F12 > Connectivity)
- Verify port 9000 is not blocked by firewall
- Try restarting Tally

### Server Connection Failed
- Check your internet connection
- Verify server URL is correct
- Try logging out and back in
- Check if NexInvo server is online

### Sync Not Working
- Check both connections are green
- Verify ledger mappings in NexInvo
- Check Setu logs for errors
- Ensure invoice has valid data

## Development

### Project Structure
```
Setu/
├── src/
│   ├── main/           # Electron main process
│   │   ├── main.js     # App entry point
│   │   ├── preload.js  # IPC bridge
│   │   └── logger.js   # Logging
│   ├── renderer/       # UI (HTML/CSS/JS)
│   │   ├── index.html
│   │   ├── styles.css
│   │   └── renderer.js
│   └── services/       # Core services
│       ├── websocket-client.js
│       ├── tally-connector.js
│       └── queue-manager.js
├── assets/             # Icons and images
├── build/              # Build resources
└── package.json
```

### Scripts
```bash
npm start      # Run the app
npm run dev    # Development mode with DevTools
npm run build  # Build for Windows
npm run pack   # Create unpacked build for testing
```

### Building

```bash
# Install dependencies
npm install

# Build Windows installer
npm run build:win

# Output will be in dist/ folder
```

## Backend Requirements

The NexInvo backend needs Django Channels for WebSocket support:

```bash
pip install channels channels-redis
```

Add to `settings.py`:
```python
INSTALLED_APPS = [
    ...
    'channels',
]

ASGI_APPLICATION = 'nexinvo.asgi.application'

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [('127.0.0.1', 6379)],
        },
    },
}
```

## Security

- All communication is encrypted (WSS/HTTPS)
- JWT tokens expire and refresh automatically
- No sensitive data stored locally (only auth tokens)
- Tally communication stays local (localhost only)

## Support

For issues or feature requests, contact NexInvo support or create an issue in the repository.

## License

MIT License - Copyright (c) 2024 NexInvo
