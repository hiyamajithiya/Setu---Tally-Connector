# Backend Integration Guide for Setu

This guide explains how to integrate Setu connector with your NexInvo Django backend.

## Prerequisites

- Django 3.2+
- Django Channels 4.0+
- Redis (for channel layers)

## Installation Steps

### 1. Install Required Packages

```bash
pip install channels channels-redis daphne
```

### 2. Update Django Settings

Add to `settings.py`:

```python
INSTALLED_APPS = [
    # ... other apps
    'channels',
]

# Channels Configuration
ASGI_APPLICATION = 'nexinvo.asgi.application'

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            "hosts": [('127.0.0.1', 6379)],
        },
    },
}
```

### 3. Files Already Created

The following files have been created in your `backend/` directory:

#### `api/setu_consumer.py`
WebSocket consumer that handles Setu connector connections. Features:
- Authentication via JWT token
- Connection tracking
- Message routing (SYNC_REQUEST, CHECK_CONNECTION, GET_LEDGERS, etc.)
- Heartbeat/ping-pong

#### `api/setu_views.py`
REST API endpoints for Setu operations:
- `POST /api/setu/check-tally/` - Request Tally connection check
- `POST /api/setu/get-ledgers/` - Fetch ledgers from Tally
- `POST /api/setu/sync-invoices/` - Sync invoices to Tally
- `GET /api/setu/status/` - Check if connector is online
- `GET /api/setu/sync-status/<id>/` - Get sync operation status

#### `api/routing.py`
WebSocket URL routing configuration.

#### Updated `nexinvo/asgi.py`
Configured ProtocolTypeRouter for HTTP and WebSocket protocols.

#### Updated `api/urls.py`
Added Setu API endpoints.

#### Updated `frontend/src/services/api.js`
Added `setuAPI` client with methods to interact with Setu endpoints.

### 4. Database Migrations (If Needed)

If you want to track Setu sync operations in the database, create a model:

```python
# api/models.py
from django.db import models

class SetuSyncOperation(models.Model):
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('in_progress', 'In Progress'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('queued', 'Queued Offline'),
    ]

    request_id = models.CharField(max_length=100, unique=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    invoice_count = models.IntegerField(default=0)
    success_count = models.IntegerField(default=0)
    failed_count = models.IntegerField(default=0)
    error_message = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey('auth.User', on_delete=models.CASCADE)

    class Meta:
        ordering = ['-created_at']
```

Then run:
```bash
python manage.py makemigrations
python manage.py migrate
```

### 5. Start Required Services

#### Start Redis (for Channels)
```bash
redis-server
```

#### Run Django with Daphne (ASGI server)
```bash
daphne -b 0.0.0.0 -p 8000 nexinvo.asgi:application
```

Or for development with auto-reload:
```bash
python manage.py runserver
```

Note: `runserver` in Django 3.0+ supports ASGI and Channels.

### 6. Update CORS Settings (If Needed)

If your frontend is on a different domain:

```python
# settings.py
INSTALLED_APPS = [
    # ...
    'corsheaders',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    # ... other middleware
]

CORS_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

# For WebSocket connections
CORS_ALLOW_CREDENTIALS = True
```

## Using Setu from Frontend

### Check Connector Status

```javascript
import { setuAPI } from './services/api';

const checkSetuStatus = async () => {
  const response = await setuAPI.checkStatus();
  if (response.connected) {
    console.log('Setu is online');
  } else {
    console.log('Setu is offline');
  }
};
```

### Request Tally Connection Check

```javascript
const checkTally = async () => {
  const result = await setuAPI.checkTallyConnection();
  console.log('Tally status:', result);
};
```

### Get Ledgers from Tally

```javascript
const fetchLedgers = async () => {
  const ledgers = await setuAPI.getLedgers();
  console.log('Ledgers:', ledgers);
};
```

### Sync Invoices to Tally

```javascript
const syncInvoices = async (invoiceIds, mapping) => {
  const result = await setuAPI.syncInvoices(invoiceIds, mapping);

  // Poll for status
  const checkStatus = setInterval(async () => {
    const status = await setuAPI.getSyncStatus(result.sync_id);
    console.log('Sync status:', status);

    if (status.status === 'completed' || status.status === 'failed') {
      clearInterval(checkStatus);
    }
  }, 2000);
};
```

## WebSocket Message Format

### Messages from Server to Setu

```json
{
  "type": "SYNC_REQUEST",
  "data": {
    "requestId": "unique-id",
    "invoices": [...],
    "mapping": {
      "ledger_sales": "Sales Account",
      "ledger_debtors": "Sundry Debtors"
    }
  }
}
```

```json
{
  "type": "CHECK_CONNECTION"
}
```

```json
{
  "type": "GET_LEDGERS"
}
```

### Messages from Setu to Server

```json
{
  "type": "SYNC_RESULT",
  "data": {
    "requestId": "unique-id",
    "success": [...],
    "failed": [...]
  }
}
```

```json
{
  "type": "CONNECTION_STATUS",
  "data": {
    "connected": true,
    "companyName": "Company Name",
    "tallyVersion": "6.6.3"
  }
}
```

```json
{
  "type": "LEDGERS_RESPONSE",
  "data": {
    "ledgers": ["Sales", "Cash", ...]
  }
}
```

## Testing

### Test WebSocket Connection

```bash
# Install wscat
npm install -g wscat

# Connect (replace token with actual JWT)
wscat -c "ws://localhost:8000/ws/setu/" -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Test REST Endpoints

```bash
# Check status
curl http://localhost:8000/api/setu/status/

# Request Tally check (requires authentication)
curl -X POST http://localhost:8000/api/setu/check-tally/ \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Monitoring

### Check Active Connections

Add a management command to check active Setu connections:

```python
# api/management/commands/check_setu_connections.py
from django.core.management.base import BaseCommand
from api.setu_consumer import active_connections

class Command(BaseCommand):
    def handle(self, *args, **options):
        count = len(active_connections)
        self.stdout.write(f'Active Setu connections: {count}')
        for user_id, channel_name in active_connections.items():
            self.stdout.write(f'  User {user_id}: {channel_name}')
```

Run with:
```bash
python manage.py check_setu_connections
```

## Troubleshooting

### WebSocket connection fails
- Ensure Redis is running
- Check ASGI configuration in `asgi.py`
- Verify URL routing in `routing.py`
- Check firewall/proxy settings

### Authentication errors
- Verify JWT token is valid
- Check token expiration
- Ensure `Authorization` header format: `Bearer <token>`

### Messages not received
- Check channel layer configuration
- Verify Redis connection
- Check consumer code for errors

## Production Deployment

### Use a production ASGI server

```bash
# Install
pip install uvicorn

# Run
uvicorn nexinvo.asgi:application --host 0.0.0.0 --port 8000 --workers 4
```

### Configure Nginx for WebSocket

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Use Redis Sentinel for HA

```python
CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'sentinels': [
                ('sentinel1', 26379),
                ('sentinel2', 26379),
            ],
            'master_name': 'mymaster',
        },
    },
}
```

## Security Considerations

1. **Always use HTTPS/WSS in production**
2. **Validate JWT tokens** on every WebSocket message
3. **Rate limit** API endpoints
4. **Sanitize** data from Tally before saving to database
5. **Log** all sync operations for audit trail
6. **Implement** connection limits per user

## Next Steps

1. Test the integration locally
2. Add proper error handling and logging
3. Implement sync operation tracking in database
4. Add UI components in frontend for Setu status
5. Set up monitoring and alerts for production
6. Document your Tally ledger mapping configuration

For questions, refer to:
- Django Channels docs: https://channels.readthedocs.io/
- Setu app docs: See `SETUP.md` in Setu folder
