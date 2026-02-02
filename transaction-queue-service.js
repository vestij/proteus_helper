const Datastore = require('nedb-promises');
const path = require('path');
const { app, net } = require('electron');
const EventEmitter = require('events');

class TransactionQueueService extends EventEmitter {
    constructor() {
        super();
        this.db = null;
        this.isOnline = true;
        this.retryTimer = null;
        this.healthCheckTimer = null;
        this.apiBaseUrl = null;
        this.apiKey = null;
        this.testMode = false;
        this.stats = {
            syncedToday: 0,
            lastSync: null
        };
    }

    /**
     * Initialize the queue database and start monitoring
     */
    async initialize(userDataPath, config = {}) {
        console.log('=== INITIALIZING TRANSACTION QUEUE SERVICE ===');

        // Set up database path
        const dbPath = path.join(userDataPath, 'transaction-queue.db');
        console.log('Queue database path:', dbPath);

        // Initialize NeDB
        this.db = Datastore.create({
            filename: dbPath,
            autoload: true,
            timestampData: true
        });

        // Create indexes for efficient queries
        await this.db.ensureIndex({ fieldName: 'idempotencyKey', unique: true });
        await this.db.ensureIndex({ fieldName: 'status' });
        await this.db.ensureIndex({ fieldName: 'createdAt' });

        // Load config
        this.apiBaseUrl = config.apiBaseUrl;
        this.apiKey = config.apiKey;
        this.testMode = process.argv.includes('--test-queue') || process.env.TEST_QUEUE === 'true';

        if (this.testMode) {
            console.log('Transaction queue running in TEST MODE - API calls will be simulated');
        }

        // Start network monitoring
        this.startNetworkMonitoring();

        // Process any pending transactions from previous session
        const pendingCount = await this.getPendingCount();
        if (pendingCount > 0) {
            console.log(`Found ${pendingCount} pending transactions from previous session`);
            // Delay initial processing to let app fully start
            setTimeout(() => this.processQueue(), 5000);
        }

        // Reset daily stats at midnight
        this.scheduleDailyReset();

        console.log('Transaction queue service initialized');
        return { success: true };
    }

    /**
     * Update API configuration
     */
    updateConfig(config) {
        if (config.apiBaseUrl) this.apiBaseUrl = config.apiBaseUrl;
        if (config.apiKey) this.apiKey = config.apiKey;
        console.log('Transaction queue config updated');
    }

    /**
     * Submit a transaction - tries API first, queues on failure
     */
    async submitTransaction(transaction) {
        console.log('=== SUBMIT TRANSACTION ===');
        console.log('Idempotency key:', transaction.idempotencyKey);

        // Validate required fields
        if (!transaction.idempotencyKey) {
            return {
                success: false,
                error: 'idempotencyKey is required for transaction submission'
            };
        }

        if (!transaction.data) {
            return {
                success: false,
                error: 'Transaction data is required'
            };
        }

        // Check for duplicate
        const existing = await this.db.findOne({ idempotencyKey: transaction.idempotencyKey });
        if (existing) {
            console.log('Duplicate transaction detected:', existing.status);
            if (existing.status === 'completed') {
                return {
                    success: true,
                    duplicate: true,
                    data: existing.response,
                    message: 'Transaction already processed'
                };
            } else if (existing.status === 'pending' || existing.status === 'processing') {
                const position = await this.getQueuePosition(existing._id);
                return {
                    success: true,
                    queued: true,
                    duplicate: true,
                    queuePosition: position,
                    message: 'Transaction already in queue'
                };
            }
        }

        // Check if we're online and have API config
        if (!this.apiBaseUrl || !this.apiKey) {
            console.log('API not configured, queueing transaction');
            return await this.queueTransaction(transaction, 'API not configured');
        }

        // Try to submit directly if online
        if (this.isOnline) {
            const result = await this.sendToAPI(transaction);

            if (result.success) {
                // Store completed transaction for reference
                await this.storeCompletedTransaction(transaction, result.data);
                this.stats.syncedToday++;
                this.stats.lastSync = new Date();
                this.emit('transactionSynced', { transaction, response: result.data });
                return result;
            } else if (result.shouldQueue) {
                // Network/server error - queue it
                return await this.queueTransaction(transaction, result.error);
            } else {
                // Client error - don't queue, return error
                return result;
            }
        } else {
            // Offline - queue it
            return await this.queueTransaction(transaction, 'Network offline');
        }
    }

    /**
     * Send transaction to SaaS API (uses /webservices/orders/ with addInvoice action)
     */
    async sendToAPI(transaction) {
        console.log('Sending transaction to API...');

        // Test mode - simulate API response
        if (this.testMode) {
            console.log('TEST MODE: Simulating API response');
            await this.simulateNetworkDelay();

            // Simulate occasional failures for testing
            if (Math.random() < 0.1) {
                return {
                    success: false,
                    shouldQueue: true,
                    error: 'TEST MODE: Simulated network failure'
                };
            }

            return {
                success: true,
                data: {
                    transactionId: 'TEST-' + Date.now(),
                    receiptNumber: 'R-' + Math.floor(Math.random() * 100000),
                    timestamp: new Date().toISOString(),
                    testMode: true
                }
            };
        }

        try {
            const fetch = (await import('node-fetch')).default;

            // Format transaction data for Proteus orders API (addInvoice action)
            const orderData = this.formatForOrdersAPI(transaction);

            const response = await fetch(`${this.apiBaseUrl}/webservices/orders/?type=standard`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(orderData),
                timeout: 30000
            });

            // Get response as text first to check if it's valid JSON
            const responseText = await response.text();

            // Check if response is HTML (error page) instead of JSON
            if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
                console.log('Received HTML response instead of JSON - endpoint may not exist');
                return {
                    success: false,
                    shouldQueue: true,
                    error: 'Orders endpoint not available - transaction will be queued'
                };
            }

            let result;
            try {
                result = JSON.parse(responseText);
            } catch (parseError) {
                console.log('Failed to parse API response as JSON:', responseText.substring(0, 200));
                return {
                    success: false,
                    shouldQueue: true,
                    error: 'Invalid response from server - transaction will be queued'
                };
            }

            // Check for error in response
            if (result.error) {
                const errorMsg = result.details ? `${result.error}: ${result.details}` : result.error;
                console.log('API returned error:', errorMsg);
                // Some errors should be queued for retry, others are permanent failures
                const shouldQueue = errorMsg.includes('timeout') ||
                                   errorMsg.includes('connection') ||
                                   errorMsg.includes('unavailable');
                return {
                    success: false,
                    shouldQueue: shouldQueue,
                    error: errorMsg
                };
            }

            // Check for success response
            if (result.success || result.invoiceid || result.invoice_id) {
                console.log('API call successful, invoice:', result.invoiceid || result.invoice_id);
                return {
                    success: true,
                    data: {
                        invoiceId: result.invoiceid || result.invoice_id,
                        ...result
                    }
                };
            } else if (response.status >= 500) {
                // Server error - should retry
                console.log('Server error, will queue for retry');
                return {
                    success: false,
                    shouldQueue: true,
                    error: `Server error: ${response.status}`
                };
            } else if (response.status === 429) {
                // Rate limited - should retry with backoff
                console.log('Rate limited, will queue for retry');
                return {
                    success: false,
                    shouldQueue: true,
                    error: 'Rate limited - will retry later',
                    retryAfter: response.headers.get('Retry-After')
                };
            } else {
                // Unknown response format - queue it to be safe
                console.log('Unknown response format:', result);
                return {
                    success: false,
                    shouldQueue: true,
                    error: 'Unexpected response format'
                };
            }

        } catch (error) {
            console.error('API request failed:', error.message);

            // Network errors should be queued
            const isNetworkError = error.code === 'ECONNREFUSED' ||
                                   error.code === 'ENOTFOUND' ||
                                   error.code === 'ETIMEDOUT' ||
                                   error.name === 'AbortError' ||
                                   error.message.includes('network') ||
                                   error.message.includes('fetch');

            if (isNetworkError) {
                this.setOffline();
            }

            return {
                success: false,
                shouldQueue: isNetworkError,
                error: error.message
            };
        }
    }

    /**
     * Format transaction data for Proteus /webservices/orders/ API
     * Converts emergency POS transaction format to addInvoice format
     */
    formatForOrdersAPI(transaction) {
        const data = transaction.data || {};
        const items = data.items || [];

        // Format date as MM/DD/YYYY HH:MM:SS for ColdFusion compatibility
        const now = data.timestamp ? new Date(data.timestamp) : new Date();
        const invoiceDate = `${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')}/${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
        const nowISO = now.toISOString();

        // Format items for orders API with all required fields
        const formattedItems = items.map(item => {
            const qty = parseInt(item.qty || item.quantity) || 1;
            const price = parseFloat(item.price) || 0;
            // Extract line item discount - can be an object { type, value, amount } or a number
            let lineDiscount = 0;
            if (item.discount) {
                if (typeof item.discount === 'object' && item.discount.amount !== undefined) {
                    // Emergency POS format: { type: 'percent'|'dollar', value: number, amount: number }
                    lineDiscount = parseFloat(item.discount.amount) || 0;
                } else {
                    lineDiscount = parseFloat(item.discount) || 0;
                }
            }
            return {
                sku: item.sku || '',
                name: item.name || item.sku || 'Item',
                price: price,
                base_original_price: price,
                qty_ordered: qty,
                qty_shipped: qty,
                qty_invoiced: qty,
                qty_refunded: 0,
                discountamt: lineDiscount * qty,  // Total discount for this line (per-item discount * qty)
                tax_amount: 0,
                weight: 0,
                updated_at: nowISO,
                created_at: nowISO,
                packageid: item.packageId || ''  // Include package barcode
            };
        });

        // Calculate totals
        const subtotal = parseFloat(data.subtotal) || 0;
        const tax = parseFloat(data.tax) || 0;
        const total = parseFloat(data.total) || 0;
        // Extract order discount - can be an object { type, value, amount } or a number
        let orderDiscount = 0;
        if (data.orderDiscount) {
            if (typeof data.orderDiscount === 'object' && data.orderDiscount.amount !== undefined) {
                // Emergency POS format: { type: 'percent'|'dollar', value: number, amount: number }
                orderDiscount = parseFloat(data.orderDiscount.amount) || 0;
            } else {
                orderDiscount = parseFloat(data.orderDiscount) || 0;
            }
        } else if (data.discount) {
            orderDiscount = parseFloat(data.discount) || 0;
        }

        // Round to 2 decimal places
        orderDiscount = Math.round(orderDiscount * 100) / 100;

        // Calculate total discount (sum of all line item discounts + order-level discount)
        const totalLineItemDiscount = formattedItems.reduce((sum, item) => sum + (item.discountamt || 0), 0);
        const totalDiscount = Math.round((totalLineItemDiscount + orderDiscount) * 100) / 100;

        // Get payment method - emergency POS uses payment.method
        const paymentMethod = data.payment?.method || data.paymentMethod || 'Cash';
        const formattedPaymentMethod = paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1).toLowerCase();

        // Generate numeric invoice ID from timestamp (external_invoiceid is BIGINT in DB)
        const numericInvoiceId = Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');

        // Build the order payload with ALL required fields
        const orderPayload = {
            // Required action and auth
            action: 'addInvoice',
            webservicepass: this.apiKey,

            // Invoice identification
            invoiceID: numericInvoiceId,
            incrementID: '',

            // Dates
            invoicedate: invoiceDate,
            created_at: nowISO,
            updated_at: nowISO,

            // Status
            Status: 'complete',
            status: 'complete',

            // Items
            items: formattedItems,

            // Totals
            subtotal: subtotal,
            totaltax: Math.round(tax * 100) / 100,
            totalamount: Math.round(total * 100) / 100,
            discountamt: totalDiscount,
            total_paid: Math.round(total * 100) / 100,
            // Rounding adjustment is stored as shipping_amount in Proteus
            shipping_amount: Math.round((parseFloat(data.roundingAdjustment) || 0) * 100) / 100,

            // Payment
            paymentType: formattedPaymentMethod,
            payment: {
                amount_paid: total
            },

            // Shipping
            shipping_type: 'pickup',

            // Customer - extract from nested customer object or flat properties
            customerID: '',
            customertype: data.customer?.type || data.customertype || 'recreational',

            // Customer details for walk-in (use "unknown" for anonymous to match existing customer)
            customerDetails: {
                fname: this.extractCustomerFirstName(data),
                lname: this.extractCustomerLastName(data),
                phone: data.customer?.phone || data.customerPhone || '',
                email: data.customer?.email || data.customerEmail || '',
                shippingAddress: {
                    address1: '',
                    address2: '',
                    city: '',
                    province: '',
                    postalCode: '',
                    countryCode: ''
                }
            },

            // Notes - include transaction notes if provided
            deliveryinstructions: data.notes
                ? `${data.notes}\n\n[Emergency POS Sale - ${transaction.idempotencyKey}]`
                : `Emergency POS Sale - ${transaction.idempotencyKey}`
        };

        // Override with specific customer if provided (from search)
        const customerId = data.customer?.id || data.customerId;
        if (customerId) {
            orderPayload.proteusCustID = customerId;
            // Clear customerDetails when using existing customer ID
            orderPayload.customerDetails = null;
        }

        // Include staff/employee ID if provided
        const staffId = data.employee?.id || data.staffid || data.staffId;
        if (staffId) {
            orderPayload.staffid = staffId;
        }

        return orderPayload;
    }

    /**
     * Extract first name from customer data
     * Handles both nested customer object and flat properties
     */
    extractCustomerFirstName(data) {
        // Try nested customer object first (from emergency POS)
        if (data.customer?.name) {
            const nameParts = data.customer.name.trim().split(' ');
            return nameParts[0] || 'unknown';
        }
        // Try flat properties
        if (data.customerName) {
            return data.customerName;
        }
        return 'unknown';
    }

    /**
     * Extract last name from customer data
     * Handles both nested customer object and flat properties
     */
    extractCustomerLastName(data) {
        // Try nested customer object first (from emergency POS)
        if (data.customer?.name) {
            const nameParts = data.customer.name.trim().split(' ');
            return nameParts.slice(1).join(' ') || 'unknown';
        }
        // Try flat properties
        if (data.customerLastName) {
            return data.customerLastName;
        }
        return 'unknown';
    }

    /**
     * Queue a transaction for later processing
     */
    async queueTransaction(transaction, reason) {
        console.log('Queueing transaction. Reason:', reason);

        const queuedTxn = {
            idempotencyKey: transaction.idempotencyKey,
            type: transaction.type || 'sale',
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
            retryCount: 0,
            maxRetries: 10,
            lastError: reason,
            lastAttempt: null,
            data: transaction.data,
            response: null
        };

        try {
            await this.db.insert(queuedTxn);
            const position = await this.getPendingCount();

            console.log('Transaction queued at position:', position);
            this.emit('transactionQueued', { transaction: queuedTxn, position });

            // Start retry timer if not already running
            this.scheduleRetry();

            return {
                success: true,
                queued: true,
                queuePosition: position,
                message: `Transaction queued: ${reason}`
            };
        } catch (error) {
            if (error.errorType === 'uniqueViolated') {
                // Already queued
                const existing = await this.db.findOne({ idempotencyKey: transaction.idempotencyKey });
                const position = await this.getQueuePosition(existing._id);
                return {
                    success: true,
                    queued: true,
                    duplicate: true,
                    queuePosition: position,
                    message: 'Transaction already in queue'
                };
            }

            console.error('Failed to queue transaction:', error);
            return {
                success: false,
                error: `Failed to queue transaction: ${error.message}`
            };
        }
    }

    /**
     * Store a completed transaction for reference
     */
    async storeCompletedTransaction(transaction, response) {
        try {
            await this.db.insert({
                idempotencyKey: transaction.idempotencyKey,
                type: transaction.type || 'sale',
                status: 'completed',
                createdAt: new Date(),
                updatedAt: new Date(),
                retryCount: 0,
                data: transaction.data,
                response: response
            });
        } catch (error) {
            // Ignore duplicate errors - already stored
            if (error.errorType !== 'uniqueViolated') {
                console.error('Failed to store completed transaction:', error);
            }
        }
    }

    /**
     * Process all pending transactions in queue
     */
    async processQueue() {
        console.log('=== PROCESSING QUEUE ===');

        if (!this.isOnline) {
            console.log('Still offline, skipping queue processing');
            return { processed: 0, failed: 0, remaining: await this.getPendingCount() };
        }

        // Get pending transactions ordered by creation time (FIFO)
        const pending = await this.db.find({ status: 'pending' }).sort({ createdAt: 1 });
        console.log(`Found ${pending.length} pending transactions`);

        let processed = 0;
        let failed = 0;

        for (const txn of pending) {
            // Check retry limit
            if (txn.retryCount >= txn.maxRetries) {
                console.log(`Transaction ${txn.idempotencyKey} exceeded max retries, marking as failed`);
                await this.markFailed(txn._id, 'Max retries exceeded');
                failed++;
                continue;
            }

            // Mark as processing
            await this.db.update(
                { _id: txn._id },
                { $set: { status: 'processing', lastAttempt: new Date() } }
            );

            // Try to send
            const result = await this.sendToAPI({
                idempotencyKey: txn.idempotencyKey,
                type: txn.type,
                data: txn.data
            });

            if (result.success) {
                await this.markCompleted(txn._id, result.data);
                processed++;
                this.stats.syncedToday++;
                this.stats.lastSync = new Date();
                this.emit('transactionSynced', { transaction: txn, response: result.data });
            } else if (result.shouldQueue) {
                // Put back in queue with incremented retry count
                await this.db.update(
                    { _id: txn._id },
                    {
                        $set: {
                            status: 'pending',
                            lastError: result.error,
                            updatedAt: new Date()
                        },
                        $inc: { retryCount: 1 }
                    }
                );

                // If we got a network error, stop processing the queue
                if (!this.isOnline) {
                    console.log('Went offline during processing, stopping');
                    break;
                }
            } else {
                // Permanent failure
                await this.markFailed(txn._id, result.error);
                failed++;
            }

            // Small delay between transactions to avoid overwhelming the API
            await this.delay(500);
        }

        const remaining = await this.getPendingCount();
        console.log(`Queue processing complete. Processed: ${processed}, Failed: ${failed}, Remaining: ${remaining}`);

        this.emit('queueProcessed', { processed, failed, remaining });

        // Schedule next retry if there are still pending transactions
        if (remaining > 0) {
            this.scheduleRetry();
        }

        return { processed, failed, remaining };
    }

    /**
     * Mark a transaction as completed
     */
    async markCompleted(txnId, response) {
        await this.db.update(
            { _id: txnId },
            { $set: { status: 'completed', response: response, updatedAt: new Date() } }
        );
    }

    /**
     * Mark a transaction as failed
     */
    async markFailed(txnId, error) {
        await this.db.update(
            { _id: txnId },
            { $set: { status: 'failed', lastError: error, updatedAt: new Date() } }
        );
        this.emit('transactionFailed', { txnId, error });
    }

    /**
     * Get queue status for UI
     */
    async getQueueStatus() {
        const pending = await this.getPendingCount();
        const failed = await this.db.count({ status: 'failed' });
        const completedToday = this.stats.syncedToday;

        return {
            success: true,
            data: {
                pending: pending,
                failed: failed,
                syncedToday: completedToday,
                lastSync: this.stats.lastSync,
                isOnline: this.isOnline,
                testMode: this.testMode
            }
        };
    }

    /**
     * Get list of queued transactions
     */
    async getQueuedTransactions(limit = 50) {
        const transactions = await this.db
            .find({ status: { $in: ['pending', 'processing', 'failed'] } })
            .sort({ createdAt: -1 })
            .limit(limit);

        return {
            success: true,
            data: transactions.map(txn => ({
                id: txn._id,
                idempotencyKey: txn.idempotencyKey,
                type: txn.type,
                status: txn.status,
                createdAt: txn.createdAt,
                retryCount: txn.retryCount,
                lastError: txn.lastError,
                // Don't include full data in list view
                amount: txn.data?.total || txn.data?.amount
            }))
        };
    }

    /**
     * Cancel/remove a queued transaction
     */
    async cancelTransaction(txnId) {
        const txn = await this.db.findOne({ _id: txnId });

        if (!txn) {
            return { success: false, error: 'Transaction not found' };
        }

        if (txn.status === 'completed') {
            return { success: false, error: 'Cannot cancel completed transaction' };
        }

        if (txn.status === 'processing') {
            return { success: false, error: 'Cannot cancel transaction currently being processed' };
        }

        await this.db.remove({ _id: txnId });
        console.log('Transaction cancelled:', txnId);

        return { success: true, message: 'Transaction cancelled' };
    }

    /**
     * Retry a specific failed transaction
     */
    async retryTransaction(txnId) {
        const txn = await this.db.findOne({ _id: txnId });

        if (!txn) {
            return { success: false, error: 'Transaction not found' };
        }

        if (txn.status !== 'failed') {
            return { success: false, error: 'Only failed transactions can be retried' };
        }

        // Reset to pending
        await this.db.update(
            { _id: txnId },
            { $set: { status: 'pending', retryCount: 0, updatedAt: new Date() } }
        );

        // Trigger queue processing
        this.processQueue();

        return { success: true, message: 'Transaction queued for retry' };
    }

    /**
     * Get count of pending transactions
     */
    async getPendingCount() {
        return await this.db.count({ status: 'pending' });
    }

    /**
     * Get queue position for a transaction
     */
    async getQueuePosition(txnId) {
        const pending = await this.db.find({ status: 'pending' }).sort({ createdAt: 1 });
        const index = pending.findIndex(t => t._id === txnId);
        return index >= 0 ? index + 1 : 0;
    }

    /**
     * Start network monitoring
     */
    startNetworkMonitoring() {
        console.log('Starting network monitoring');

        // Check initial status
        this.checkNetworkStatus();

        // Poll regularly - more frequently when offline or queue has items
        this.healthCheckTimer = setInterval(async () => {
            const hadQueue = (await this.getPendingCount()) > 0;
            await this.checkNetworkStatus();

            // If we just came back online and have pending items, process
            if (this.isOnline && hadQueue) {
                this.processQueue();
            }
        }, this.isOnline ? 60000 : 15000); // 1 min online, 15 sec offline
    }

    /**
     * Check network status by pinging API
     */
    async checkNetworkStatus() {
        // First check Electron's network status
        const electronOnline = net.isOnline();

        if (!electronOnline) {
            this.setOffline();
            return;
        }

        // If we have API config, also check API reachability
        if (this.apiBaseUrl && this.apiKey && !this.testMode) {
            try {
                const fetch = (await import('node-fetch')).default;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(`${this.apiBaseUrl}/webservices/health/`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${this.apiKey}` },
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (response.ok || response.status === 404) {
                    // 404 is ok - endpoint might not exist but API is reachable
                    this.setOnline();
                } else if (response.status >= 500) {
                    this.setOffline();
                }
            } catch (error) {
                this.setOffline();
            }
        } else {
            // No API config or test mode - use Electron's status
            if (electronOnline) {
                this.setOnline();
            }
        }
    }

    /**
     * Mark as online
     */
    setOnline() {
        if (!this.isOnline) {
            console.log('Network status: ONLINE');
            this.isOnline = true;
            this.emit('online');
        }
    }

    /**
     * Mark as offline
     */
    setOffline() {
        if (this.isOnline) {
            console.log('Network status: OFFLINE');
            this.isOnline = false;
            this.emit('offline');
        }
    }

    /**
     * Schedule retry with exponential backoff
     */
    scheduleRetry() {
        if (this.retryTimer) {
            return; // Already scheduled
        }

        // Calculate delay based on queue state
        const baseDelay = 30000; // 30 seconds
        const delay = this.isOnline ? baseDelay : baseDelay * 2;

        console.log(`Scheduling queue retry in ${delay / 1000} seconds`);

        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null;

            if (this.isOnline) {
                await this.processQueue();
            } else {
                // Check if we're back online
                await this.checkNetworkStatus();
                if (this.isOnline) {
                    await this.processQueue();
                } else {
                    // Still offline, reschedule
                    const pendingCount = await this.getPendingCount();
                    if (pendingCount > 0) {
                        this.scheduleRetry();
                    }
                }
            }
        }, delay);
    }

    /**
     * Reset daily stats at midnight
     */
    scheduleDailyReset() {
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const msUntilMidnight = tomorrow - now;

        setTimeout(() => {
            this.stats.syncedToday = 0;
            console.log('Daily stats reset');
            this.scheduleDailyReset(); // Schedule next reset
        }, msUntilMidnight);
    }

    /**
     * Clean up old completed transactions
     */
    async cleanup(daysToKeep = 7) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - daysToKeep);

        const removed = await this.db.remove(
            { status: 'completed', createdAt: { $lt: cutoff } },
            { multi: true }
        );

        console.log(`Cleaned up ${removed} old completed transactions`);

        // Compact the database
        await this.db.persistence.compactDatafile();

        return { removed };
    }

    /**
     * Utility: delay helper
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Utility: simulate network delay for test mode
     */
    simulateNetworkDelay() {
        const delay = 200 + Math.random() * 800; // 200-1000ms
        return this.delay(delay);
    }

    /**
     * Shutdown the service
     */
    shutdown() {
        console.log('Shutting down transaction queue service');

        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }

        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
}

module.exports = TransactionQueueService;
