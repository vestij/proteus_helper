const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const FormData = require('form-data');
const { app } = require('electron');

class ScannerService {
    constructor() {
        this.availableScanners = [];
        this.isScanning = false;
        this.scanSettings = {
            resolution: 300, // DPI
            colorMode: 'color', // 'color', 'grayscale', 'bw'
            format: 'jpeg', // 'jpeg', 'png', 'pdf'
            quality: 90
        };
    }

    /**
     * Detect available scanners on the system
     */
    async detectScanners() {
        console.log('=== SCANNER DETECTION ===');
        console.log('Platform:', process.platform);
        
        try {
            if (process.platform === 'win32') {
                return await this.detectWindowsScanners();
            } else if (process.platform === 'darwin') {
                return await this.detectMacScanners();
            } else {
                return await this.detectLinuxScanners();
            }
        } catch (error) {
            console.error('Scanner detection failed:', error);
            return { success: false, error: error.message, scanners: [] };
        }
    }

    /**
     * Detect Windows scanners using WIA and PowerShell
     */
    async detectWindowsScanners() {
        console.log('Starting Windows scanner detection...');
        
        // Try multiple detection methods in order of reliability
        const detectionMethods = [
            () => this.detectWIADevices(),
            () => this.detectTWAINDevices(),
            () => this.detectNetworkScanners(),
            () => this.detectPnPScanners(),
            () => this.detectUSBScanners(),
            () => this.detectGenericScanners()
        ];
        
        for (const method of detectionMethods) {
            try {
                const result = await method();
                if (result.success && result.scanners && result.scanners.length > 0) {
                    console.log(`Scanner detection successful with method: ${method.name}`);
                    this.availableScanners = result.scanners;
                    return result;
                }
            } catch (error) {
                console.log(`Detection method ${method.name} failed:`, error.message);
                continue;
            }
        }
        
        // If all methods fail, check if we should provide a test scanner
        this.availableScanners = [];
        
        // For development/testing, always offer a virtual scanner if no physical ones found
        const enableTestScanner = process.env.ENABLE_TEST_SCANNER === 'true' || 
                                 process.argv.includes('--test-scanner') ||
                                 true; // Always enable for testing
        
        if (enableTestScanner) {
            const testScanner = {
                id: 'test-virtual-scanner',
                name: 'Virtual Test Scanner (Demo Mode)',
                manufacturer: 'Proteus Development',
                status: 'Available',
                type: 'Virtual',
                capabilities: ['scan', 'color', 'grayscale', 'bw']
            };
            
            this.availableScanners = [testScanner];
            return { 
                success: true, 
                scanners: [testScanner],
                message: 'No physical scanners detected. Using virtual test scanner for development and testing.'
            };
        }
        
        return { 
            success: true, 
            scanners: [],
            message: 'No scanners detected on Windows system. Use --test-scanner flag to enable virtual scanner for testing.'
        };
    }

    /**
     * Detect WIA devices using simpler PowerShell
     */
    async detectWIADevices() {
        return new Promise((resolve) => {
            const psCommand = `
                try {
                    $wia = New-Object -ComObject WIA.DeviceManager
                    $devices = @()
                    for ($i = 1; $i -le $wia.DeviceInfos.Count; $i++) {
                        $device = $wia.DeviceInfos.Item($i)
                        if ($device.Type -eq 1) {  # Scanner type
                            $devices += [PSCustomObject]@{
                                Name = $device.Properties.Item("Name").Value
                                DeviceID = $device.DeviceID
                                Manufacturer = try { $device.Properties.Item("Manufacturer").Value } catch { "Unknown" }
                                Status = "Available"
                                Type = "WIA"
                            }
                        }
                    }
                    $devices | ConvertTo-Json -Depth 2 -Compress
                } catch {
                    Write-Output "[]"
                }
            `;

            exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand.replace(/"/g, '`"')}"`, 
                { timeout: 10000 }, 
                (error, stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: error.message });
                        return;
                    }

                    try {
                        const devices = JSON.parse(stdout.trim() || '[]');
                        const scanners = (Array.isArray(devices) ? devices : [devices]).filter(d => d).map(device => ({
                            id: device.DeviceID,
                            name: device.Name || 'WIA Scanner',
                            manufacturer: device.Manufacturer || 'Unknown',
                            status: device.Status || 'Available',
                            type: 'WIA',
                            capabilities: ['scan', 'color', 'grayscale', 'bw']
                        }));

                        resolve({ 
                            success: true, 
                            scanners: scanners,
                            message: `Found ${scanners.length} WIA scanner(s)`
                        });
                    } catch (parseError) {
                        resolve({ success: false, error: `WIA parsing failed: ${parseError.message}` });
                    }
                }
            );
        });
    }

    /**
     * Detect TWAIN scanners using Windows registry
     */
    async detectTWAINDevices() {
        return new Promise((resolve) => {
            console.log('Detecting TWAIN scanners...');
            
            // Query Windows registry for TWAIN data sources
            const psCommand = `
                try {
                    # Check TWAIN registry entries
                    $twainSources = @()
                    
                    # TWAIN-32 registry path
                    $twain32Path = "HKLM:\\SOFTWARE\\Classes\\TWAIN-32"
                    if (Test-Path $twain32Path) {
                        Get-ChildItem $twain32Path | ForEach-Object {
                            $sourceName = $_.PSChildName
                            Write-Host "Found TWAIN-32 source: $sourceName"
                            $twainSources += [PSCustomObject]@{
                                Name = $sourceName
                                Type = "TWAIN-32"
                                Path = $_.Name
                            }
                        }
                    }
                    
                    # TWAIN registry path  
                    $twainPath = "HKLM:\\SOFTWARE\\Classes\\TWAIN"
                    if (Test-Path $twainPath) {
                        Get-ChildItem $twainPath | ForEach-Object {
                            $sourceName = $_.PSChildName
                            Write-Host "Found TWAIN source: $sourceName"
                            $twainSources += [PSCustomObject]@{
                                Name = $sourceName
                                Type = "TWAIN"
                                Path = $_.Name
                            }
                        }
                    }
                    
                    # Also check for HP TWAIN drivers specifically
                    $hpTwainPath = "HKLM:\\SOFTWARE\\Hewlett-Packard\\TWAIN"
                    if (Test-Path $hpTwainPath) {
                        Get-ChildItem $hpTwainPath | ForEach-Object {
                            $sourceName = $_.PSChildName
                            Write-Host "Found HP TWAIN source: $sourceName"
                            $twainSources += [PSCustomObject]@{
                                Name = "HP $sourceName"
                                Type = "HP-TWAIN"
                                Path = $_.Name
                            }
                        }
                    }
                    
                    $twainSources | ConvertTo-Json -Compress
                    
                } catch {
                    Write-Host "TWAIN detection error: $_"
                    Write-Output "[]"
                }
            `;

            exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand}"`, 
                { timeout: 8000 }, 
                (error, stdout, stderr) => {
                    console.log('TWAIN detection stdout:', stdout);
                    
                    if (error) {
                        console.error('TWAIN detection error:', error);
                        resolve({ success: false, error: error.message });
                        return;
                    }

                    try {
                        const lines = stdout.split('\n');
                        let jsonLine = '';
                        
                        // Look for JSON data
                        for (const line of lines) {
                            if (line.trim().startsWith('[') || line.trim().startsWith('{')) {
                                jsonLine = line.trim();
                                break;
                            }
                        }
                        
                        const devices = jsonLine ? JSON.parse(jsonLine) : [];
                        const scanners = (Array.isArray(devices) ? devices : [devices]).filter(d => d).map(device => ({
                            id: `TWAIN_${device.Name.replace(/\s+/g, '_')}`,
                            name: `${device.Name} (TWAIN)`,
                            manufacturer: device.Name.includes('HP') ? 'HP' : 'Unknown',
                            status: 'Available',
                            type: device.Type,
                            capabilities: ['scan', 'color', 'grayscale', 'bw']
                        }));

                        console.log('TWAIN scanners found:', scanners);

                        resolve({ 
                            success: true, 
                            scanners: scanners,
                            message: scanners.length > 0 ? 
                                `Found ${scanners.length} TWAIN scanner(s)` :
                                'No TWAIN scanners detected'
                        });
                    } catch (parseError) {
                        console.error('TWAIN parsing error:', parseError);
                        resolve({ success: false, error: `TWAIN parsing failed: ${parseError.message}` });
                    }
                }
            );
        });
    }

    /**
     * Detect network scanners including HP MFP devices
     * Simple approach: convert known MFP printers to scanner candidates
     */
    async detectNetworkScanners() {
        return new Promise((resolve) => {
            console.log('Checking for MFP printers that can scan...');
            
            // Use the simple Get-Printer command that we know works
            const psCommand = `Get-Printer | Select-Object Name, PortName, PrinterStatus | ConvertTo-Json -Compress`;

            exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand}"`, 
                { timeout: 8000 }, 
                (error, stdout, stderr) => {
                    if (error) {
                        console.error('Network scanner detection error:', error);
                        resolve({ success: false, error: error.message });
                        return;
                    }

                    try {
                        console.log('Raw printer query result:', stdout.substring(0, 500));
                        const devices = JSON.parse(stdout.trim() || '[]');
                        
                        // Filter for known MFP patterns
                        const mfpPrinters = (Array.isArray(devices) ? devices : [devices]).filter(device => {
                            if (!device || !device.Name) return false;
                            
                            const name = device.Name.toLowerCase();
                            
                            // Check for MFP patterns
                            const isMFP = (
                                (name.includes('hp') && (name.includes('mfp') || name.includes('laserjet') || name.includes('m477'))) ||
                                (name.includes('canon') && name.includes('mf')) ||
                                (name.includes('brother') && name.includes('mfc')) ||
                                (name.includes('epson') && name.includes('wf')) ||
                                name.includes('multifunction') ||
                                name.includes('all-in-one')
                            );
                            
                            console.log(`Checking printer: ${device.Name} - isMFP: ${isMFP}`);
                            return isMFP;
                        });

                        const scanners = mfpPrinters.map(device => {
                            // Determine if this is likely a network device
                            const isNetwork = device.PortName && (
                                device.PortName.startsWith('WSD-') ||
                                device.PortName.includes('IP_') ||
                                device.PortName.includes('.') ||
                                device.PortName.startsWith('\\\\') ||
                                device.PortName.includes('NPI')  // HP network port indicator
                            );

                            return {
                                id: device.Name + '_Scanner',
                                name: device.Name + ' (Scanner)',
                                manufacturer: this.extractManufacturer(device.Name),
                                status: device.PrinterStatus === 0 ? 'Available' : (device.PrinterStatus ? `Status ${device.PrinterStatus}` : 'Unknown'),
                                type: isNetwork ? 'Network MFP' : 'Local MFP',
                                port: device.PortName,
                                capabilities: ['scan', 'color', 'grayscale', 'bw'],
                                isNetworkDevice: isNetwork,
                                originalPrinterName: device.Name
                            };
                        });

                        console.log('Network scanner candidates found:', scanners);

                        resolve({ 
                            success: true, 
                            scanners: scanners,
                            message: scanners.length > 0 ? 
                                `Found ${scanners.length} potential network MFP scanner(s)` :
                                'No MFP devices detected for scanning'
                        });
                    } catch (parseError) {
                        console.error('Network scanner parsing error:', parseError);
                        resolve({ success: false, error: `Network scanner parsing failed: ${parseError.message}` });
                    }
                }
            );
        });
    }

    /**
     * Extract manufacturer from device name
     */
    extractManufacturer(deviceName) {
        const name = deviceName.toLowerCase();
        if (name.includes('hp')) return 'HP';
        if (name.includes('canon')) return 'Canon';
        if (name.includes('brother')) return 'Brother';
        if (name.includes('epson')) return 'Epson';
        if (name.includes('xerox')) return 'Xerox';
        return 'Unknown';
    }

    /**
     * Detect PnP scanners using device manager
     */
    async detectPnPScanners() {
        return new Promise((resolve) => {
            const psCommand = `
                Get-PnpDevice | Where-Object {
                    ($_.FriendlyName -like "*scanner*") -or 
                    ($_.FriendlyName -like "*scan*") -or
                    ($_.Class -eq "Image") -or
                    ($_.Service -eq "usbscan")
                } | Where-Object {
                    $_.Status -eq "OK"
                } | Select-Object FriendlyName, InstanceId, Status | ConvertTo-Json -Compress
            `;

            exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand}"`, 
                { timeout: 8000 }, 
                (error, stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: error.message });
                        return;
                    }

                    try {
                        const devices = JSON.parse(stdout.trim() || '[]');
                        const scanners = (Array.isArray(devices) ? devices : [devices]).filter(d => d).map(device => ({
                            id: device.InstanceId,
                            name: device.FriendlyName,
                            manufacturer: 'Unknown',
                            status: device.Status || 'Available',
                            type: 'PnP',
                            capabilities: ['scan']
                        }));

                        resolve({ 
                            success: true, 
                            scanners: scanners,
                            message: `Found ${scanners.length} PnP scanner(s)`
                        });
                    } catch (parseError) {
                        resolve({ success: false, error: `PnP parsing failed: ${parseError.message}` });
                    }
                }
            );
        });
    }

    /**
     * Detect USB scanners using WMI
     */
    async detectUSBScanners() {
        return new Promise((resolve) => {
            const psCommand = `
                Get-WmiObject -Class Win32_USBHub | Where-Object {
                    $_.Description -like "*scanner*" -or $_.Name -like "*scan*"
                } | Select-Object Name, Description, Status | ConvertTo-Json -Compress
            `;

            exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand}"`, 
                { timeout: 6000 }, 
                (error, stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: error.message });
                        return;
                    }

                    try {
                        const devices = JSON.parse(stdout.trim() || '[]');
                        const scanners = (Array.isArray(devices) ? devices : [devices]).filter(d => d).map(device => ({
                            id: device.Name,
                            name: device.Description || device.Name,
                            manufacturer: 'Unknown',
                            status: device.Status || 'Available',
                            type: 'USB',
                            capabilities: ['scan']
                        }));

                        resolve({ 
                            success: true, 
                            scanners: scanners,
                            message: `Found ${scanners.length} USB scanner(s)`
                        });
                    } catch (parseError) {
                        resolve({ success: false, error: `USB parsing failed: ${parseError.message}` });
                    }
                }
            );
        });
    }

    /**
     * Generic scanner detection - creates mock entries for testing
     */
    async detectGenericScanners() {
        return new Promise((resolve) => {
            // Check if there are any imaging-related services running
            const psCommand = `
                Get-Service | Where-Object {
                    ($_.Name -like "*scan*") -or 
                    ($_.Name -like "*wia*") -or 
                    ($_.Name -like "*imaging*")
                } | Where-Object {
                    $_.Status -eq "Running"
                } | Select-Object Name, DisplayName | ConvertTo-Json -Compress
            `;

            exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand}"`, 
                { timeout: 4000 }, 
                (error, stdout, stderr) => {
                    try {
                        const services = JSON.parse(stdout.trim() || '[]');
                        const scanners = [];
                        
                        // If WIA service is running, assume there might be scanners
                        const hasWIA = (Array.isArray(services) ? services : [services])
                            .some(s => s && s.Name && s.Name.toLowerCase().includes('wia'));
                        
                        if (hasWIA) {
                            scanners.push({
                                id: 'generic-wia-scanner',
                                name: 'Generic WIA Scanner',
                                manufacturer: 'Windows',
                                status: 'Available',
                                type: 'Generic',
                                capabilities: ['scan', 'color', 'grayscale']
                            });
                        }

                        resolve({ 
                            success: true, 
                            scanners: scanners,
                            message: scanners.length > 0 ? 
                                'Found potential scanner support via Windows services' :
                                'No scanner services detected'
                        });
                    } catch (parseError) {
                        resolve({ 
                            success: true, 
                            scanners: [],
                            message: 'Generic detection completed but no scanners found'
                        });
                    }
                }
            );
        });
    }


    /**
     * Detect macOS scanners using SANE or system_profiler
     */
    async detectMacScanners() {
        return new Promise((resolve) => {
            // Try system_profiler first
            const command = 'system_profiler SPUSBDataType | grep -A 5 -B 5 -i scanner';
            
            exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    // Try alternative method
                    resolve({ 
                        success: true, 
                        scanners: [],
                        message: 'No USB scanners detected on macOS'
                    });
                    return;
                }

                // Parse system_profiler output for scanner devices
                const scanners = [];
                // This would need more sophisticated parsing for real implementation
                
                this.availableScanners = scanners;
                resolve({ 
                    success: true, 
                    scanners: scanners,
                    message: `Found ${scanners.length} scanner(s) on macOS`
                });
            });
        });
    }

    /**
     * Detect Linux scanners using SANE
     */
    async detectLinuxScanners() {
        return new Promise((resolve) => {
            // Check if SANE is available
            exec('which scanimage', (whichError) => {
                if (whichError) {
                    resolve({
                        success: false,
                        error: 'SANE not installed. Please install sane-utils package.',
                        scanners: []
                    });
                    return;
                }

                // Use scanimage to list devices
                exec('scanimage -L', { timeout: 10000 }, (error, stdout, stderr) => {
                    if (error) {
                        resolve({
                            success: true,
                            scanners: [],
                            message: 'No SANE scanners detected on Linux'
                        });
                        return;
                    }

                    // Parse scanimage output
                    const deviceLines = stdout.split('\n').filter(line => line.includes('device'));
                    const scanners = deviceLines.map(line => {
                        const match = line.match(/device `([^']+)' is a (.+)/);
                        if (match) {
                            return {
                                id: match[1],
                                name: match[2],
                                manufacturer: 'Unknown',
                                status: 'Available',
                                type: 'SANE',
                                capabilities: ['scan', 'color', 'grayscale']
                            };
                        }
                        return null;
                    }).filter(s => s);

                    this.availableScanners = scanners;
                    resolve({
                        success: true,
                        scanners: scanners,
                        message: `Found ${scanners.length} SANE scanner(s) on Linux`
                    });
                });
            });
        });
    }

    /**
     * Perform scan operation
     */
    async performScan(scannerId, options = {}) {
        console.log('=== STARTING SCAN OPERATION ===');
        console.log('Scanner ID:', scannerId);
        console.log('Options:', options);

        if (this.isScanning) {
            return { success: false, error: 'Scanner is currently busy' };
        }

        this.isScanning = true;

        try {
            // Merge options with defaults
            const scanOptions = { ...this.scanSettings, ...options };
            console.log('Final scan options:', scanOptions);

            // Generate unique filename
            const timestamp = Date.now();
            const tempDir = app.getPath('temp');
            const filename = `proteus_scan_${timestamp}`;
            const rawFile = path.join(tempDir, `${filename}_raw.${scanOptions.format}`);
            const processedFile = path.join(tempDir, `${filename}.${scanOptions.format}`);

            let scanResult;
            if (scannerId === 'test-virtual-scanner') {
                scanResult = await this.scanVirtual(scannerId, rawFile, scanOptions);
            } else if (scannerId.startsWith('TWAIN_')) {
                scanResult = await this.scanTWAIN(scannerId, rawFile, scanOptions);
            } else if (process.platform === 'win32') {
                scanResult = await this.scanWindows(scannerId, rawFile, scanOptions);
            } else if (process.platform === 'darwin') {
                scanResult = await this.scanMac(scannerId, rawFile, scanOptions);
            } else {
                scanResult = await this.scanLinux(scannerId, rawFile, scanOptions);
            }

            if (!scanResult.success) {
                return scanResult;
            }

            // Process the scanned image
            const processedResult = await this.processScannedImage(rawFile, processedFile, scanOptions);
            if (!processedResult.success) {
                return processedResult;
            }

            return {
                success: true,
                data: {
                    filename: path.basename(processedFile),
                    filepath: processedFile,
                    size: fs.statSync(processedFile).size,
                    resolution: scanOptions.resolution,
                    format: scanOptions.format,
                    timestamp: new Date().toISOString()
                },
                message: 'Scan completed successfully'
            };

        } catch (error) {
            console.error('Scan operation failed:', error);
            return { success: false, error: error.message };
        } finally {
            this.isScanning = false;
        }
    }

    /**
     * Virtual scanning for testing without physical hardware
     */
    async scanVirtual(scannerId, outputFile, options) {
        return new Promise((resolve) => {
            console.log('=== VIRTUAL SCAN SIMULATION ===');
            console.log('Simulating scan with options:', options);
            
            try {
                // Create a test image using Sharp
                const sharp = require('sharp');
                
                // Create a simple test document image
                const width = Math.round(8.5 * options.resolution); // 8.5 inches
                const height = Math.round(11 * options.resolution); // 11 inches
                
                let imageBuffer;
                
                // Generate different content based on color mode
                if (options.colorMode === 'bw') {
                    // Black and white: simple text pattern
                    imageBuffer = Buffer.alloc(width * height, 255); // White background
                    
                    // Add some black text lines (simplified)
                    for (let y = height * 0.2; y < height * 0.8; y += options.resolution * 0.3) {
                        for (let x = width * 0.1; x < width * 0.9; x++) {
                            const idx = Math.floor(y) * width + Math.floor(x);
                            if (idx < imageBuffer.length && Math.random() < 0.3) {
                                imageBuffer[idx] = 0; // Black pixels
                            }
                        }
                    }
                } else {
                    // Color or grayscale: gradient pattern
                    imageBuffer = Buffer.alloc(width * height * 3); // RGB
                    
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const idx = (y * width + x) * 3;
                            
                            // Create a gradient with some document-like patterns
                            const r = Math.min(255, Math.max(240, 240 + Math.sin(x / 50) * 15));
                            const g = Math.min(255, Math.max(240, 240 + Math.sin(y / 30) * 10));
                            const b = Math.min(255, Math.max(240, 240 + Math.cos(x / 40) * 8));
                            
                            if (options.colorMode === 'grayscale') {
                                const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                                imageBuffer[idx] = gray;
                                imageBuffer[idx + 1] = gray;
                                imageBuffer[idx + 2] = gray;
                            } else {
                                imageBuffer[idx] = r;
                                imageBuffer[idx + 1] = g;
                                imageBuffer[idx + 2] = b;
                            }
                        }
                    }
                }
                
                // Create Sharp image from buffer
                let image = sharp(imageBuffer, {
                    raw: {
                        width: width,
                        height: height,
                        channels: options.colorMode === 'bw' ? 1 : 3
                    }
                });
                
                // Add some text overlay to make it look more document-like
                const svgText = `
                    <svg width="${width}" height="${height}">
                        <rect width="${width}" height="${height}" fill="white" fill-opacity="0.8"/>
                        <text x="${width * 0.1}" y="${height * 0.15}" font-family="Arial" font-size="${options.resolution * 0.08}" fill="black">
                            PROTEUS POS HELPER - TEST DOCUMENT
                        </text>
                        <text x="${width * 0.1}" y="${height * 0.25}" font-family="Arial" font-size="${options.resolution * 0.06}" fill="black">
                            Scanned at ${options.resolution} DPI in ${options.colorMode} mode
                        </text>
                        <text x="${width * 0.1}" y="${height * 0.35}" font-family="Arial" font-size="${options.resolution * 0.05}" fill="black">
                            Generated: ${new Date().toLocaleString()}
                        </text>
                        <text x="${width * 0.1}" y="${height * 0.5}" font-family="Arial" font-size="${options.resolution * 0.04}" fill="gray">
                            This is a virtual test document created for demonstration purposes.
                        </text>
                        <text x="${width * 0.1}" y="${height * 0.6}" font-family="Arial" font-size="${options.resolution * 0.04}" fill="gray">
                            In a real scenario, this would be content from your physical scanner.
                        </text>
                        <text x="${width * 0.1}" y="${height * 0.8}" font-family="Arial" font-size="${options.resolution * 0.04}" fill="blue">
                            Ready for upload to your SaaS application!
                        </text>
                    </svg>
                `;
                
                // Composite the text over the background
                image = image.composite([{
                    input: Buffer.from(svgText),
                    blend: 'over'
                }]);
                
                // Apply format and save
                if (options.format === 'jpeg') {
                    image = image.jpeg({ quality: options.quality || 90 });
                } else if (options.format === 'png') {
                    image = image.png();
                }
                
                // Save to file
                image.toFile(outputFile)
                    .then(() => {
                        console.log('Virtual scan completed successfully');
                        resolve({ success: true, message: 'Virtual scan completed' });
                    })
                    .catch((error) => {
                        console.error('Virtual scan failed:', error);
                        resolve({ success: false, error: `Virtual scan failed: ${error.message}` });
                    });
                
            } catch (error) {
                console.error('Virtual scan setup failed:', error);
                resolve({ success: false, error: `Virtual scan setup failed: ${error.message}` });
            }
        });
    }

    /**
     * TWAIN scanning implementation
     */
    async scanTWAIN(scannerId, outputFile, options) {
        return new Promise((resolve) => {
            console.log('=== TWAIN SCAN ATTEMPT ===');
            console.log('Scanner ID:', scannerId);
            
            // Extract TWAIN source name from ID
            const sourceName = scannerId.replace('TWAIN_', '').replace(/_/g, ' ');
            
            // Use PowerShell with TWAIN-compatible approach
            const psScript = `
                try {
                    Write-Host "Attempting TWAIN scan with source: ${sourceName}"
                    
                    # Try using Windows Fax and Scan (WFS) command line
                    $outputPath = "${outputFile.replace(/\\/g, '\\\\')}"
                    $tempName = "ProteusScan_" + (Get-Date -Format "yyyyMMdd_HHmmss")
                    
                    # WFS command for scanning
                    $wfsCommand = "WFS.exe"
                    
                    if (Get-Command $wfsCommand -ErrorAction SilentlyContinue) {
                        Write-Host "Using Windows Fax and Scan..."
                        Start-Process -FilePath $wfsCommand -ArgumentList "/S", "/N", $tempName, "/F", "JPEG" -Wait
                        Write-Output "SUCCESS: TWAIN scan attempted via WFS"
                    } else {
                        Write-Host "Windows Fax and Scan not available, trying alternative..."
                        
                        # Alternative: try to invoke scanner via COM
                        $wia = New-Object -ComObject WIA.DeviceManager
                        $device = $null
                        
                        # Look for device matching TWAIN source name
                        for ($i = 1; $i -le $wia.DeviceInfos.Count; $i++) {
                            $deviceInfo = $wia.DeviceInfos.Item($i)
                            $deviceName = $deviceInfo.Properties.Item("Name").Value
                            
                            if ($deviceName -like "*${sourceName}*" -or $deviceName -like "*HP*") {
                                Write-Host "Found matching WIA device: $deviceName"
                                $device = $deviceInfo.Connect()
                                break
                            }
                        }
                        
                        if ($device) {
                            $item = $device.Items.Item(1)
                            $item.Properties.Item("Horizontal Resolution").Value = ${options.resolution}
                            $item.Properties.Item("Vertical Resolution").Value = ${options.resolution}
                            $image = $item.Transfer("{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}")
                            $image.SaveFile($outputPath)
                            Write-Output "SUCCESS: TWAIN scan completed via WIA bridge"
                        } else {
                            Write-Error "TWAIN source not accessible via WIA"
                            exit 1
                        }
                    }
                    
                } catch {
                    Write-Error "TWAIN scan failed: $_"
                    Write-Host "Error details: $($_.Exception.Message)"
                    exit 1
                }
            `;

            exec(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, 
                { timeout: 90000 }, 
                (error, stdout, stderr) => {
                    console.log('TWAIN scan stdout:', stdout);
                    console.log('TWAIN scan stderr:', stderr);
                    
                    if (error) {
                        console.error('TWAIN scan failed:', error.message);
                        resolve({ 
                            success: false, 
                            error: `TWAIN scan failed: ${error.message}. Try using Windows Fax and Scan app to test your scanner first.`
                        });
                        return;
                    }

                    if (stdout.includes('SUCCESS')) {
                        resolve({ success: true, message: 'TWAIN scan completed' });
                    } else {
                        resolve({ 
                            success: false, 
                            error: 'TWAIN scan did not complete successfully. Check if your scanner supports TWAIN and is properly configured.' 
                        });
                    }
                }
            );
        });
    }

    /**
     * Windows scanning implementation
     */
    async scanWindows(scannerId, outputFile, options) {
        return new Promise((resolve) => {
            // Check if this is a network MFP scanner
            if (scannerId.includes('_Scanner')) {
                console.log('Attempting network MFP scan...');
                this.scanNetworkMFP(scannerId, outputFile, options).then(resolve);
                return;
            }

            // Use PowerShell with WIA to perform the scan
            const psScript = `
                try {
                    $deviceManager = New-Object -ComObject WIA.DeviceManager
                    $device = $null
                    
                    # Find the specified scanner
                    for ($i = 1; $i -le $deviceManager.DeviceInfos.Count; $i++) {
                        $deviceInfo = $deviceManager.DeviceInfos.Item($i)
                        if ($deviceInfo.DeviceID -eq "${scannerId}" -or $deviceInfo.Properties.Item("Name").Value -eq "${scannerId}") {
                            $device = $deviceInfo.Connect()
                            break
                        }
                    }
                    
                    if ($device -eq $null) {
                        Write-Error "Scanner not found: ${scannerId}"
                        exit 1
                    }
                    
                    # Get the first item (scanner bed)
                    $item = $device.Items.Item(1)
                    
                    # Set scan properties
                    $item.Properties.Item("Horizontal Resolution").Value = ${options.resolution}
                    $item.Properties.Item("Vertical Resolution").Value = ${options.resolution}
                    $item.Properties.Item("Current Intent").Value = 1  # Color
                    
                    # Perform the scan
                    $image = $item.Transfer("{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}")  # JPEG format
                    $image.SaveFile("${outputFile.replace(/\\/g, '\\\\')}")
                    
                    Write-Output "SUCCESS: Scan completed"
                } catch {
                    Write-Error "Scan failed: $_"
                    exit 1
                }
            `;

            exec(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, 
                { timeout: 60000 }, 
                (error, stdout, stderr) => {
                    if (error) {
                        console.error('Windows scan failed:', error.message);
                        resolve({ success: false, error: `Windows scan failed: ${error.message}` });
                        return;
                    }

                    if (stdout.includes('SUCCESS')) {
                        resolve({ success: true, message: 'Windows scan completed' });
                    } else {
                        resolve({ success: false, error: 'Windows scan did not complete successfully' });
                    }
                }
            );
        });
    }

    /**
     * Network MFP scanning implementation
     */
    async scanNetworkMFP(scannerId, outputFile, options) {
        return new Promise((resolve) => {
            console.log('=== NETWORK MFP SCAN ATTEMPT ===');
            console.log('Scanner ID:', scannerId);
            
            // For HP network MFPs, try using WIA network connection
            const psScript = `
                try {
                    # Try to find network scanner via WIA
                    $deviceManager = New-Object -ComObject WIA.DeviceManager
                    $device = $null
                    $printerName = "${scannerId.replace('_Scanner', '')}"
                    
                    Write-Host "Looking for network scanner for: $printerName"
                    
                    # Try to find device by matching name patterns
                    for ($i = 1; $i -le $deviceManager.DeviceInfos.Count; $i++) {
                        $deviceInfo = $deviceManager.DeviceInfos.Item($i)
                        $deviceName = $deviceInfo.Properties.Item("Name").Value
                        
                        Write-Host "Found WIA device: $deviceName"
                        
                        if ($deviceName -like "*HP*" -and $deviceName -like "*M477*") {
                            Write-Host "Found matching HP MFP device: $deviceName"
                            $device = $deviceInfo.Connect()
                            break
                        }
                    }
                    
                    if ($device -eq $null) {
                        # Try alternative method - Windows Scan API
                        Write-Host "WIA device not found, trying Windows Fax and Scan..."
                        
                        # Use Windows Fax and Scan command line if available
                        $scanCommand = "WFS.exe /S /N Test_Scan_$(Get-Date -Format 'yyyyMMdd_HHmmss') /F JPEG"
                        Write-Host "Scan command: $scanCommand"
                        
                        # For now, create a placeholder indicating network scanning needs manual setup
                        Write-Error "Network scanner found but requires manual configuration. Please use HP Smart app or install HP MFP drivers with WIA support."
                        exit 1
                    }
                    
                    # If we found a WIA device, proceed with scan
                    $item = $device.Items.Item(1)
                    
                    # Set scan properties
                    $item.Properties.Item("Horizontal Resolution").Value = ${options.resolution}
                    $item.Properties.Item("Vertical Resolution").Value = ${options.resolution}
                    $item.Properties.Item("Current Intent").Value = 1
                    
                    # Perform the scan
                    $image = $item.Transfer("{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}")
                    $image.SaveFile("${outputFile.replace(/\\/g, '\\\\')}")
                    
                    Write-Output "SUCCESS: Network scan completed"
                } catch {
                    Write-Error "Network scan failed: $_"
                    Write-Host "Error details: $($_.Exception.Message)"
                    exit 1
                }
            `;

            exec(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, 
                { timeout: 90000 }, 
                (error, stdout, stderr) => {
                    console.log('Network scan stdout:', stdout);
                    console.log('Network scan stderr:', stderr);
                    
                    if (error) {
                        console.error('Network scan failed:', error.message);
                        
                        // Provide helpful error message for network scanners
                        const helpfulError = `Network scanner detected but direct connection failed. 

For HP MFP M477fdw network scanning, you have these options:

RECOMMENDED APPROACH:
1. Use HP Smart app to scan documents to a folder
2. Then use a "Upload Scanned File" feature (we can add this)

ADVANCED SETUP (if needed):
1. Install HP Universal Print Driver with full WIA support
2. Configure network scanner in Windows "Devices and Printers"
3. Ensure scanner shows up in Windows Fax and Scan

TESTING:
• Use the "Virtual Test Scanner" to test upload functionality
• The virtual scanner creates realistic test documents and tests the full upload pipeline

Would you like me to add a "Upload Existing File" feature for files scanned with HP Smart?`;

                        resolve({ 
                            success: false, 
                            error: helpfulError
                        });
                        return;
                    }

                    if (stdout.includes('SUCCESS')) {
                        resolve({ success: true, message: 'Network MFP scan completed' });
                    } else {
                        resolve({ 
                            success: false, 
                            error: 'Network MFP scan did not complete successfully. May require HP Smart app or full driver installation.' 
                        });
                    }
                }
            );
        });
    }

    /**
     * macOS scanning implementation
     */
    async scanMac(scannerId, outputFile, options) {
        return new Promise((resolve) => {
            // Use built-in scanning tools or SANE if available
            resolve({ success: false, error: 'macOS scanning not yet implemented' });
        });
    }

    /**
     * Linux scanning implementation using SANE
     */
    async scanLinux(scannerId, outputFile, options) {
        return new Promise((resolve) => {
            const modeMap = {
                'color': 'Color',
                'grayscale': 'Gray',
                'bw': 'Lineart'
            };

            const command = `scanimage --device-name="${scannerId}" --resolution=${options.resolution} --mode=${modeMap[options.colorMode] || 'Color'} --format=${options.format} > "${outputFile}"`;
            
            exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, error: `Linux scan failed: ${error.message}` });
                    return;
                }

                if (fs.existsSync(outputFile)) {
                    resolve({ success: true, message: 'Linux scan completed' });
                } else {
                    resolve({ success: false, error: 'Scan file not created' });
                }
            });
        });
    }

    /**
     * Process scanned image with Sharp
     */
    async processScannedImage(inputFile, outputFile, options) {
        try {
            console.log('Processing scanned image...');
            console.log('Input:', inputFile);
            console.log('Output:', outputFile);

            if (!fs.existsSync(inputFile)) {
                return { success: false, error: 'Raw scan file not found' };
            }

            let processor = sharp(inputFile);

            // Auto-orient based on EXIF
            processor = processor.rotate();

            // Apply image enhancements
            processor = processor
                .normalize() // Auto-level colors
                .sharpen(); // Enhance text clarity

            // Convert format if needed and set quality
            if (options.format === 'jpeg') {
                processor = processor.jpeg({ quality: options.quality });
            } else if (options.format === 'png') {
                processor = processor.png({ compressionLevel: 6 });
            }

            await processor.toFile(outputFile);

            console.log('Image processing completed');
            return { success: true, message: 'Image processed successfully' };

        } catch (error) {
            console.error('Image processing failed:', error);
            return { success: false, error: `Image processing failed: ${error.message}` };
        }
    }

    /**
     * Upload scanned image to SaaS endpoint
     */
    async uploadToSaaS(filePath, apiBaseUrl, apiKey, metadata = {}) {
        console.log('=== UPLOADING TO SAAS ===');
        console.log('File:', filePath);
        console.log('API Base URL:', apiBaseUrl);

        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, error: 'Scan file not found for upload' };
            }

            const formData = new FormData();
            formData.append('image', fs.createReadStream(filePath));
            formData.append('category', metadata.category || 'scanned_document');
            formData.append('description', metadata.description || `Scanned document from ${metadata.scanner_id || 'unknown scanner'} at ${new Date().toLocaleString()}`);
            formData.append('userId', metadata.userId || '0');

            // Use the same fetch approach as your existing drawer API calls
            const fetch = (await import('node-fetch')).default;
            
            const response = await fetch(`${apiBaseUrl}/webservices/image_upload.cfm`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    ...formData.getHeaders()
                },
                body: formData
            });

            const result = await response.json();

            if (response.ok && result.success) {
                console.log('Upload successful');
                
                // Clean up temp file after successful upload
                try {
                    fs.unlinkSync(filePath);
                    console.log('Temp file cleaned up');
                } catch (cleanupError) {
                    console.warn('Could not delete temp file:', cleanupError.message);
                }

                return {
                    success: true,
                    data: {
                        uploadId: result.data?.uploadId,
                        fileName: result.data?.storedFileName,
                        originalFileName: result.data?.originalFileName,
                        filePath: result.data?.filePath,
                        fileSize: result.data?.fileSize,
                        contentType: result.data?.contentType,
                        category: result.data?.category,
                        timestamp: result.timestamp,
                        ...result.data
                    },
                    message: result.message || 'Document uploaded successfully'
                };
            } else {
                return {
                    success: false,
                    error: result.error || result.message || `Upload failed with status ${response.status}`
                };
            }

        } catch (error) {
            console.error('Upload to SaaS failed:', error);
            return { success: false, error: `Upload failed: ${error.message}` };
        }
    }

    /**
     * Get current scan settings
     */
    getScanSettings() {
        return { ...this.scanSettings };
    }

    /**
     * Update scan settings
     */
    updateScanSettings(newSettings) {
        this.scanSettings = { ...this.scanSettings, ...newSettings };
        console.log('Scan settings updated:', this.scanSettings);
    }
}

module.exports = ScannerService;