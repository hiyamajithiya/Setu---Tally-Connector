const WebSocket = require('ws');
const logger = require('../main/logger');

class WebSocketClient {
  constructor(options) {
    this.serverUrl = options.serverUrl;
    this.authToken = options.authToken;
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onError = options.onError || (() => {});

    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3; // Reduced from 10 - WebSocket is optional
    this.reconnectDelay = 30000; // Increased from 5000 to 30 seconds
    this.pingInterval = null;
    this.pongTimeout = null;
    this._isConnected = false;
    this.isReconnecting = false;
    this.shouldReconnect = true;
    this.websocketNotSupported = false; // Flag to stop retrying if server doesn't support WS
  }

  connect() {
    // Don't try to connect if server doesn't support WebSocket
    if (this.websocketNotSupported) {
      logger.info('WebSocket not supported by server, skipping connection');
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.info('WebSocket already connected');
      return;
    }

    this.shouldReconnect = true;

    try {
      const url = `${this.serverUrl}?token=${this.authToken}`;
      logger.info(`Connecting to WebSocket: ${this.serverUrl}`);

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.authToken}`
        }
      });

      this.ws.on('open', () => {
        logger.info('WebSocket connected');
        this._isConnected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.startPingPong();
        this.onConnect();

        // Send initial registration
        this.send({
          type: 'REGISTER',
          data: {
            client: 'setu',
            version: require('../../package.json').version,
            timestamp: Date.now()
          }
        });
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          logger.debug('Received message:', message.type);

          if (message.type === 'PONG') {
            this.handlePong();
            return;
          }

          this.onMessage(message);
        } catch (error) {
          logger.error('Failed to parse message:', error);
        }
      });

      this.ws.on('close', (code, reason) => {
        logger.info(`WebSocket closed: ${code} - ${reason}`);
        this.handleDisconnect();
      });

      this.ws.on('error', (error) => {
        logger.error('WebSocket error:', error.message);

        // Check if server doesn't support WebSocket (404 or connection refused)
        if (error.message && (
          error.message.includes('404') ||
          error.message.includes('Unexpected server response') ||
          error.message.includes('ECONNREFUSED')
        )) {
          logger.info('Server does not support WebSocket - disabling reconnection');
          this.websocketNotSupported = true;
          this.shouldReconnect = false;
        }

        this.onError(error);
      });

    } catch (error) {
      logger.error('Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  handleDisconnect() {
    this._isConnected = false;
    this.stopPingPong();
    this.onDisconnect();

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.isReconnecting) return;
    if (this.websocketNotSupported) {
      logger.info('WebSocket not supported, not scheduling reconnect');
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.info('Max reconnection attempts reached - WebSocket is optional, REST API still works');
      this.websocketNotSupported = true; // Stop trying after max attempts
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Use longer delays to avoid flooding the server
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      300000 // Max 5 minutes
    );

    logger.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.isReconnecting = false;
      this.connect();
    }, delay);
  }

  startPingPong() {
    this.stopPingPong();

    // Send ping every 30 seconds
    this.pingInterval = setInterval(() => {
      if (this._isConnected) {
        this.send({ type: 'PING', timestamp: Date.now() });

        // Expect pong within 10 seconds
        this.pongTimeout = setTimeout(() => {
          logger.warn('Pong timeout, closing connection');
          if (this.ws) {
            this.ws.close();
          }
        }, 10000);
      }
    }, 30000);
  }

  handlePong() {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  stopPingPong() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket not connected, cannot send message');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      logger.debug('Sent message:', message.type);
      return true;
    } catch (error) {
      logger.error('Failed to send message:', error);
      return false;
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopPingPong();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }

    this._isConnected = false;
  }

  isConnected() {
    return this._isConnected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  updateCredentials(serverUrl, authToken) {
    this.serverUrl = serverUrl;
    this.authToken = authToken;

    // Reconnect with new credentials
    this.disconnect();
    this.connect();
  }
}

module.exports = WebSocketClient;
