/**
 * Proteus POS Helper Client
 *
 * Drop-in JavaScript for your web POS to enable:
 * - Offline transaction queuing
 * - Receipt printing
 * - Cash drawer control
 * - Document scanning
 *
 * Usage:
 *   const posHelper = new POSHelperClient();
 *   await posHelper.submitTransaction({ items: [...], total: 99.99 });
 */

class POSHelperClient {
    constructor(options = {}) {
        this.wsUrl = options.wsUrl || 'ws://localhost:8012';
        this.apiBaseUrl = options.apiBaseUrl || ''; // Your SaaS API base URL
        this.apiKey = options.apiKey || '';

        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;

        this.pendingRequests = new Map();
        this.requestId = 0;

        // Event callbacks
        this.onConnectionChange = options.onConnectionChange || (() => {});
        this.onTransactionQueued = options.onTransactionQueued || (() => {});
        this.onTransactionSynced = options.onTransactionSynced || (() => {});
        this.onError = options.onError || console.error;

        // Auto-connect
        if (options.autoConnect !== false) {
            this.connect();
        }
    }

    /**
     * Connect to the POS Helper WebSocket
     */
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            try {
                console.log('Connecting to POS Helper...', this.wsUrl);
                this.ws = new WebSocket(this.wsUrl);

                this.ws.onopen = () => {
                    console.log('POS Helper connected - offline mode available');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.onConnectionChange(true, 'connected');
                    resolve(true);
                };

                this.ws.onclose = () => {
                    console.log('POS Helper disconnected');
                    this.isConnected = false;
                    this.onConnectionChange(false, 'disconnected');
                    this.attemptReconnect();
                    resolve(false);
                };

                this.ws.onerror = (error) => {
                    console.log('POS Helper connection error:', error);
                    this.isConnected = false;
                    this.onConnectionChange(false, 'error');
                    resolve(false);
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                // Timeout for initial connection
                setTimeout(() => {
                    if (!this.isConnected) {
                        resolve(false);
                    }
                }, 5000);

            } catch (error) {
                console.log('Failed to create WebSocket:', error);
                this.isConnected = false;
                resolve(false);
            }
        });
    }

    /**
     * Attempt to reconnect after disconnect
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log('Max reconnect attempts reached');
            return;
        }

        this.reconnectAttempts++;
        console.log(`Reconnecting in ${this.reconnectDelay/1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            this.connect();
        }, this.reconnectDelay);
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(data) {
        try {
            const response = JSON.parse(data);

            // Check if this is a response to a pending request
            if (response._requestId && this.pendingRequests.has(response._requestId)) {
                const { resolve, reject } = this.pendingRequests.get(response._requestId);
                this.pendingRequests.delete(response._requestId);

                if (response.success) {
                    resolve(response);
                } else {
                    reject(new Error(response.error || 'Request failed'));
                }
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }

    /**
     * Send a request to the helper and wait for response
     */
    sendRequest(action, data = {}) {
        return new Promise((resolve, reject) => {
            if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('POS Helper not connected'));
                return;
            }

            const requestId = ++this.requestId;
            const request = {
                action,
                _requestId: requestId,
                ...data
            };

            this.pendingRequests.set(requestId, { resolve, reject });

            // Timeout for request
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 30000);

            this.ws.send(JSON.stringify(request));
        });
    }

    /**
     * Generate a unique idempotency key
     */
    generateIdempotencyKey() {
        // Use crypto.randomUUID if available, fallback to custom
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // ==========================================
    // TRANSACTION METHODS
    // ==========================================

    /**
     * Submit a transaction (with offline support)
     *
     * @param {Object} transactionData - The transaction data
     * @param {string} transactionData.type - Transaction type: 'sale', 'refund', 'void'
     * @param {Array} transactionData.items - Line items
     * @param {number} transactionData.subtotal - Subtotal amount
     * @param {number} transactionData.tax - Tax amount
     * @param {number} transactionData.total - Total amount
     * @param {string} transactionData.paymentMethod - Payment method
     * @param {Object} options - Additional options
     * @returns {Promise<Object>} - Transaction result
     */
    async submitTransaction(transactionData, options = {}) {
        const idempotencyKey = options.idempotencyKey || this.generateIdempotencyKey();

        // Try through helper first (supports offline queuing)
        if (this.isConnected) {
            try {
                const response = await this.sendRequest('submitTransaction', {
                    idempotencyKey,
                    type: transactionData.type || 'sale',
                    data: transactionData
                });

                if (response.queued) {
                    console.log('Transaction queued for sync:', response.queuePosition);
                    this.onTransactionQueued({
                        idempotencyKey,
                        position: response.queuePosition,
                        data: transactionData
                    });
                } else {
                    this.onTransactionSynced({
                        idempotencyKey,
                        response: response.data,
                        data: transactionData
                    });
                }

                return response;

            } catch (error) {
                console.warn('Helper request failed, trying direct:', error.message);
                // Fall through to direct API call
            }
        }

        // Fallback: Direct API call (no offline support)
        return this.submitTransactionDirect(transactionData, idempotencyKey);
    }

    /**
     * Submit transaction directly to API (no offline support)
     */
    async submitTransactionDirect(transactionData, idempotencyKey) {
        if (!this.apiBaseUrl) {
            throw new Error('API base URL not configured');
        }

        const response = await fetch(`${this.apiBaseUrl}/webservices/transactions/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'Idempotency-Key': idempotencyKey
            },
            body: JSON.stringify({
                idempotencyKey,
                type: transactionData.type || 'sale',
                data: transactionData
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const result = await response.json();

        if (result.SUCCESS) {
            return { success: true, data: result.DATA };
        } else {
            throw new Error(result.ERROR || 'Transaction failed');
        }
    }

    /**
     * Get queue status
     */
    async getQueueStatus() {
        if (!this.isConnected) {
            return { success: false, error: 'Not connected to helper' };
        }
        return this.sendRequest('getQueueStatus');
    }

    /**
     * Force retry queued transactions
     */
    async retryQueue() {
        if (!this.isConnected) {
            return { success: false, error: 'Not connected to helper' };
        }
        return this.sendRequest('retryQueue');
    }

    // ==========================================
    // PRINTING METHODS
    // ==========================================

    /**
     * Print a receipt
     *
     * @param {string} content - HTML or plain text content
     * @param {Object} options - Print options
     * @param {string} options.printer - Printer name (optional, uses default)
     * @param {string} options.type - 'html' or 'text' (auto-detected if not specified)
     */
    async printReceipt(content, options = {}) {
        if (!this.isConnected) {
            throw new Error('POS Helper not connected - cannot print');
        }

        return this.sendRequest('print', {
            content,
            printer: options.printer,
            type: options.type
        });
    }

    /**
     * Get available printers
     */
    async getPrinters() {
        if (!this.isConnected) {
            return { success: false, error: 'Not connected', printers: [] };
        }
        return this.sendRequest('getPrinters');
    }

    // ==========================================
    // CASH DRAWER METHODS
    // ==========================================

    /**
     * Open the cash drawer
     *
     * @param {string} printer - Printer name that controls the drawer (optional)
     */
    async openCashDrawer(printer = null) {
        if (!this.isConnected) {
            throw new Error('POS Helper not connected - cannot open drawer');
        }

        return this.sendRequest('openCashDrawer', { printer });
    }

    // ==========================================
    // SCANNER METHODS
    // ==========================================

    /**
     * Get available scanners
     */
    async getScanners() {
        if (!this.isConnected) {
            return { success: false, error: 'Not connected', scanners: [] };
        }
        return this.sendRequest('getScanners');
    }

    /**
     * Scan a document and upload to server
     *
     * @param {Object} options - Scan options
     * @param {string} options.scannerId - Scanner ID
     * @param {number} options.resolution - DPI (150, 300, 600)
     * @param {string} options.colorMode - 'color', 'grayscale', 'bw'
     * @param {Object} options.metadata - Additional metadata for upload
     */
    async scanAndUpload(options = {}) {
        if (!this.isConnected) {
            throw new Error('POS Helper not connected - cannot scan');
        }

        return this.sendRequest('scanAndUpload', {
            scannerId: options.scannerId,
            options: {
                resolution: options.resolution || 300,
                colorMode: options.colorMode || 'color',
                format: options.format || 'jpeg'
            },
            metadata: options.metadata || {}
        });
    }

    // ==========================================
    // UTILITY METHODS
    // ==========================================

    /**
     * Get helper status
     */
    async getStatus() {
        if (!this.isConnected) {
            return {
                success: false,
                connected: false,
                error: 'Not connected to POS Helper'
            };
        }

        const response = await this.sendRequest('getStatus');
        return {
            ...response,
            connected: true
        };
    }

    /**
     * Get current configuration
     */
    async getConfiguration() {
        if (!this.isConnected) {
            return { success: false, error: 'Not connected' };
        }
        return this.sendRequest('getConfiguration');
    }

    /**
     * Check if helper is available
     */
    get helperAvailable() {
        return this.isConnected;
    }

    /**
     * Disconnect from helper
     */
    disconnect() {
        if (this.ws) {
            this.maxReconnectAttempts = 0; // Prevent auto-reconnect
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = POSHelperClient;
}
if (typeof window !== 'undefined') {
    window.POSHelperClient = POSHelperClient;
}
