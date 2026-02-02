# Scanner Integration Guide

## Overview
The Proteus POS Helper now includes comprehensive document scanning capabilities that integrate with your SaaS application. This allows you to scan physical documents directly into your system from any compatible scanner.

## Features

### Scanner Detection
- **Windows**: Uses WIA (Windows Image Acquisition) and PowerShell for native scanner detection
- **Linux**: Uses SANE (Scanner Access Now Easy) for open-source scanner support
- **macOS**: Basic USB scanner detection (expandable with TWAIN support)

### Scanning Capabilities
- **Multiple Formats**: JPEG, PNG support with quality settings
- **Resolution Options**: 150 DPI (fast), 300 DPI (standard), 600 DPI (high quality)
- **Color Modes**: Full color, grayscale, black & white
- **Image Processing**: Auto-orientation, normalization, and sharpening

### Integration Options
- **Local Scanning**: Scan and save to local temp directory
- **Scan & Upload**: Automatically upload scanned documents to your SaaS
- **WebSocket API**: Full remote control via WebSocket commands

## WebSocket API Commands

### Get Available Scanners
```javascript
{
    "action": "getScanners"
}
```
**Response:**
```javascript
{
    "success": true,
    "scanners": [
        {
            "id": "scanner_device_id",
            "name": "Scanner Name",
            "manufacturer": "Scanner Manufacturer",
            "status": "Available",
            "type": "WIA",
            "capabilities": ["scan", "color", "grayscale"]
        }
    ],
    "message": "Found 1 scanner(s) on Windows"
}
```

### Perform Scan Only
```javascript
{
    "action": "scan",
    "scannerId": "scanner_device_id",
    "options": {
        "resolution": 300,
        "colorMode": "color",
        "format": "jpeg",
        "quality": 90
    }
}
```

### Scan and Upload to SaaS
```javascript
{
    "action": "scanAndUpload",
    "scannerId": "scanner_device_id",
    "options": {
        "resolution": 300,
        "colorMode": "color",
        "format": "jpeg",
        "quality": 90
    },
    "metadata": {
        "document_type": "receipt",
        "customer_id": "12345",
        "description": "Customer receipt scan"
    }
}
```

### Get/Update Scan Settings
```javascript
// Get current settings
{
    "action": "getScanSettings"
}

// Update settings
{
    "action": "updateScanSettings",
    "settings": {
        "resolution": 600,
        "colorMode": "grayscale",
        "format": "png"
    }
}
```

## UI Controls

### Scanner Management
1. **Scanner Selection**: Dropdown showing all detected scanners
2. **Refresh Scanners**: Button to re-detect available scanning devices
3. **Test Scan**: Quick scan test to verify scanner functionality
4. **Scan & Upload**: Full scan and upload to configured SaaS endpoint

### Scan Settings
- **Resolution**: 150/300/600 DPI options for different quality/speed needs
- **Color Mode**: Color/Grayscale/Black & White options
- **Format**: JPEG/PNG output format selection
- Settings are saved and restored between sessions

## Setup Requirements

### Windows
- Windows 7+ with WIA support
- PowerShell 3.0+ (usually included)
- Compatible WIA scanner drivers installed

### Linux
- SANE utilities installed: `sudo apt-get install sane-utils`
- Scanner drivers for your specific device
- User permissions for scanner access

### macOS
- macOS 10.12+ 
- Scanner drivers from manufacturer
- TWAIN drivers recommended for advanced features

## SaaS Integration

### API Endpoint
The scanner uploads to: `{apiBaseUrl}/webservices/documents/upload`

### Upload Format
- **Method**: POST
- **Authorization**: Bearer {apiKey}
- **Content-Type**: multipart/form-data
- **Fields**:
  - `scanned_document`: The image file
  - `metadata`: JSON string with additional document info

### Expected Response
```javascript
{
    "SUCCESS": true,
    "DATA": {
        "id": "document_id",
        "url": "https://your-saas.com/documents/view/document_id",
        "filename": "scanned_document.jpg",
        "created_at": "2025-01-XX"
    }
}
```

## Testing Without Physical Scanner

For development and testing purposes, you can enable a virtual test scanner:

### Enable Virtual Scanner
```bash
# Environment variable method
ENABLE_TEST_SCANNER=true npm start

# Command line flag method  
npm start -- --test-scanner
```

### Virtual Scanner Features
- **Virtual Test Scanner (Demo Mode)**: Simulates a physical scanner
- **Generates Test Documents**: Creates realistic-looking scanned documents
- **All Settings Supported**: Tests resolution, color modes, and formats
- **Upload Testing**: Can test full scan-and-upload workflow
- **Image Processing**: Exercises all image processing capabilities

The virtual scanner creates test documents with:
- Proper dimensions based on selected resolution
- Different output based on color mode selection
- Text overlays showing scan settings and timestamp
- Realistic file sizes for upload testing

## Troubleshooting

### Scanner Not Detected
1. Verify scanner is connected and powered on
2. Check that drivers are properly installed
3. Test scanner with native OS tools (Windows Scan, SANE tools)
4. Try refreshing scanner list in the application
5. **For Testing**: Use `--test-scanner` flag to enable virtual scanner

### Scan Fails
1. Ensure document is properly placed on scanner bed
2. Check scanner isn't in use by another application
3. Try different resolution settings (lower = more reliable)
4. Verify scanner supports selected color mode

### Upload Fails
1. Verify API configuration is correct (Base URL and API Key)
2. Check internet connectivity
3. Ensure SaaS endpoint `/webservices/documents/upload` exists
4. Verify API key has document upload permissions

### Performance Issues
1. Use lower resolution (150 DPI) for faster scans
2. Use JPEG format for smaller file sizes
3. Ensure adequate disk space in temp directory
4. Close other scanning applications

## Examples

### JavaScript Usage from Web App
```javascript
// Connect to Proteus POS Helper
const ws = new WebSocket('ws://localhost:8012');

// Get available scanners
ws.send(JSON.stringify({
    action: 'getScanners'
}));

// Scan and upload a document
ws.send(JSON.stringify({
    action: 'scanAndUpload',
    scannerId: 'detected_scanner_id',
    options: {
        resolution: 300,
        colorMode: 'color',
        format: 'jpeg'
    },
    metadata: {
        document_type: 'invoice',
        customer_id: '12345'
    }
}));
```

### Testing Scanner Functionality
1. Open Proteus POS Helper application
2. Navigate to Document Scanner section
3. Click "Refresh Scanners" to detect devices
4. Select your scanner from dropdown
5. Click "Test Scan" to verify functionality
6. Configure API settings if using "Scan & Upload"
7. Adjust scan settings as needed for your use case

## Technical Implementation

### Architecture
- **ScannerService**: Core scanning logic and device management
- **WebSocket API**: Remote control interface for web applications
- **Image Processing**: Sharp.js for optimization and format conversion
- **Upload Pipeline**: Form-data multipart uploads to SaaS endpoint

### Dependencies Added
- `sharp@^0.33.5`: High-performance image processing
- `form-data@^4.0.0`: Multipart form data construction
- `node-fetch@^3.3.2`: Modern HTTP client for uploads

### Security Considerations
- Scanner access requires appropriate system permissions
- Temporary files are cleaned up after processing
- API keys are stored securely in application config
- Image uploads use HTTPS connections to SaaS

This scanner integration provides a complete solution for digitizing physical documents directly into your Proteus ERP system, streamlining document management workflows.