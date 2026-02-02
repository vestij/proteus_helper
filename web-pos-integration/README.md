# Web POS Integration Guide

This folder contains the JavaScript client for integrating your browser-based POS with the Proteus POS Helper app.

## Quick Start

### 1. Include the script in your web POS

```html
<script src="pos-helper-client.js"></script>
```

Or copy the contents into your existing JavaScript bundle.

### 2. Initialize the client

```javascript
const posHelper = new POSHelperClient({
    // Your SaaS API URL (used as fallback when helper not available)
    apiBaseUrl: 'https://your-server.com/api',
    apiKey: 'your-api-key',

    // Called when connection status changes
    onConnectionChange: (connected, reason) => {
        if (connected) {
            showNotification('Offline mode available');
        }
    },

    // Called when a transaction is queued (offline)
    onTransactionQueued: (info) => {
        showNotification(`Transaction queued - position ${info.position}`);
    }
});
```

### 3. Submit transactions

```javascript
// This automatically uses the helper if available, falls back to direct API if not
const result = await posHelper.submitTransaction({
    type: 'sale',
    items: [
        { sku: 'ITEM-001', name: 'Widget', qty: 2, price: 19.99 }
    ],
    subtotal: 39.98,
    tax: 3.30,
    total: 43.28,
    paymentMethod: 'credit',
    cashierId: 'EMP-123',
    registerId: 'POS-01'
});

if (result.queued) {
    // Transaction was queued because network is down
    console.log('Will sync when online, position:', result.queuePosition);
} else {
    // Transaction completed successfully
    console.log('Transaction ID:', result.data.transactionId);
}
```

## API Reference

### Transactions

```javascript
// Submit transaction (with offline support)
await posHelper.submitTransaction(data, options)

// Check queue status
await posHelper.getQueueStatus()
// Returns: { pending: 3, syncedToday: 47, isOnline: true }

// Force retry queued transactions
await posHelper.retryQueue()
```

### Printing

```javascript
// Print HTML receipt
await posHelper.printReceipt('<div>Receipt content...</div>')

// Print to specific printer
await posHelper.printReceipt(content, { printer: 'EPSON TM-m30' })

// Get available printers
await posHelper.getPrinters()
```

### Cash Drawer

```javascript
// Open cash drawer
await posHelper.openCashDrawer()

// Open drawer connected to specific printer
await posHelper.openCashDrawer('EPSON TM-m30')
```

### Scanning

```javascript
// Get available scanners
await posHelper.getScanners()

// Scan and upload document
await posHelper.scanAndUpload({
    scannerId: 'scanner-id',
    resolution: 300,
    colorMode: 'color',
    metadata: { documentType: 'receipt', customerId: '123' }
})
```

### Connection Status

```javascript
// Check if helper is connected
if (posHelper.helperAvailable) {
    // Offline mode is available
}

// Get full status
await posHelper.getStatus()
```

## How Offline Mode Works

1. When your web POS loads, it connects to the helper via WebSocket (port 8012)
2. When you submit a transaction:
   - If helper is connected: Transaction is sent to helper
   - Helper forwards to your SaaS API
   - If API fails (network down): Transaction is queued locally in the helper
   - When network returns: Helper automatically syncs queued transactions
3. If helper is not available: Falls back to direct API calls (no offline support)

## Files

- `pos-helper-client.js` - The client library (include this in your web POS)
- `example-usage.html` - Interactive demo page

## Testing

1. Start the POS Helper app with test mode:
   ```bash
   TEST_QUEUE=true npm start
   ```

2. Open `example-usage.html` in your browser

3. Click "Submit Test Sale" to test the transaction flow

4. To simulate offline: Stop the helper app or disconnect network
