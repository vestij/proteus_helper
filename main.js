const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Allow self-signed/updated SSL certs for node-fetch calls to our own servers
// (matches the Electron certificate-error bypass already in place for webContents)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Config path helper: write to userData, read from userData with __dirname fallback
function getConfigPath(forWrite = false) {
  const fs = require('fs');
  const userDataConfig = path.join(app.getPath('userData'), 'config.json');
  if (forWrite) return userDataConfig;
  if (fs.existsSync(userDataConfig)) return userDataConfig;
  const localConfig = path.join(__dirname, 'config.json');
  if (fs.existsSync(localConfig)) return localConfig;
  return userDataConfig;
}

// Prevent multiple instances - must be before anything else
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Keep a global reference of the window object and tray
let mainWindow;
let emergencyWindow;
let tray;
let wsServer;
let scannerService;
let transactionQueueService;
let productCacheService;

// Set up logging for built app
if (!app.isPackaged) {
  // Development mode - logs go to console
  console.log('Running in development mode');
} else {
  // Production mode - set up log file
  const logPath = path.join(app.getPath('userData'), 'app.log');
  console.log('Production mode - logs will be written to:', logPath);
  
  // Redirect console.log to file in production
  const originalLog = console.log;
  console.log = (...args) => {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] ${args.join(' ')}\n`;
    
    try {
      fs.appendFileSync(logPath, message);
    } catch (e) {
      // If file write fails, still show in original console
      originalLog('Log write failed:', e.message);
    }
    
    // Also show in original console
    originalLog(...args);
  };
}

// Get configuration (selected printer, drawer, etc.)
async function getConfiguration() {
    try {
      let config = {
        selectedPrinter: null,
        selectedDrawer: null,
        selectedDrawerId: null,
        drawerInfo: null,
        apiBaseUrl: null,
        version: '1.0.0'
      };
      
      // In Electron, we need to read from the main window's localStorage
      if (mainWindow && mainWindow.webContents) {
        try {
          console.log('Reading configuration from localStorage...');
          
          // Execute JavaScript in the renderer process to get localStorage values
          const localStorageData = await mainWindow.webContents.executeJavaScript(`
            (function() {
              try {
                const config = {};
                
                // Get all localStorage keys that might be configuration
                const keys = [
                  'selectedPrinter',
                  'selectedDrawer', 
                  'selectedDrawerId',
                  'drawerInfo',
                  'apiBaseUrl',
                  'proteushelper-config', // Common key name
                  'config' // Another common key name
                ];
                
                keys.forEach(key => {
                  const value = localStorage.getItem(key);
                  if (value !== null) {
                    try {
                      // Try to parse as JSON first
                      config[key] = JSON.parse(value);
                    } catch (e) {
                      // If not JSON, store as string
                      config[key] = value;
                    }
                  }
                });
                
                // Also get all localStorage keys to see what's actually stored
                const allKeys = Object.keys(localStorage);
                config._allLocalStorageKeys = allKeys;
                
                // Get all localStorage contents for debugging
                const allData = {};
                allKeys.forEach(key => {
                  try {
                    const value = localStorage.getItem(key);
                    allData[key] = value;
                  } catch (e) {
                    allData[key] = '[Error reading]';
                  }
                });
                config._allLocalStorageData = allData;
                
                return config;
              } catch (error) {
                return { error: error.message };
              }
            })();
          `);
          
          console.log('localStorage data retrieved:', JSON.stringify(localStorageData, null, 2));
          
          if (localStorageData.error) {
            console.error('Error reading localStorage:', localStorageData.error);
          } else {
            // Map localStorage data to our config structure
            if (localStorageData.selectedPrinter) {
              config.selectedPrinter = localStorageData.selectedPrinter;
            }
            if (localStorageData.selectedDrawer) {
              config.selectedDrawer = localStorageData.selectedDrawer;
            }
            if (localStorageData.selectedDrawerId) {
              config.selectedDrawerId = localStorageData.selectedDrawerId;
            }
            if (localStorageData.drawerInfo) {
              config.drawerInfo = localStorageData.drawerInfo;
            }
            if (localStorageData.apiBaseUrl) {
              config.apiBaseUrl = localStorageData.apiBaseUrl;
            }
            
            // Check for complete config objects
            if (localStorageData['proteushelper-config']) {
              config = { ...config, ...localStorageData['proteushelper-config'] };
            }
            if (localStorageData.config && typeof localStorageData.config === 'object') {
              config = { ...config, ...localStorageData.config };
            }
            
            // Add debug info
            config._debug = {
              allLocalStorageKeys: localStorageData._allLocalStorageKeys,
              allLocalStorageData: localStorageData._allLocalStorageData
            };
          }
          
        } catch (executeError) {
          console.error('Error executing localStorage read:', executeError);
        }
      }
      
      // Fallback: try to read from config.json file
      const fs = require('fs');
      const path = require('path');
      const { app } = require('electron');
      
      try {
        const configPath = getConfigPath();

        if (fs.existsSync(configPath)) {
          console.log('Also found config.json file, merging...');
          const fileData = fs.readFileSync(configPath, 'utf8');
          const fileConfig = JSON.parse(fileData);
          config = { ...fileConfig, ...config }; // localStorage takes precedence
        }
      } catch (fileError) {
        console.log('No config.json file found or error reading it:', fileError.message);
      }
      
      console.log('Final configuration being returned:', JSON.stringify(config, null, 2));
      
      return { 
        success: true, 
        data: config
      };
    } catch (error) {
      console.error('Error getting configuration:', error);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

const fs = require('fs');
const { exec } = require('child_process');
const WebSocket = require('ws');
const { electron } = require('process');
const ScannerService = require('./scanner-service');
const TransactionQueueService = require('./transaction-queue-service');
const ProductCacheService = require('./product-cache-service');

// Try to load thermal printer library (optional)
let ThermalPrinter;
let PrinterTypes;
try {
  const thermalModule = require('node-thermal-printer');
  ThermalPrinter = thermalModule.ThermalPrinter;
  PrinterTypes = thermalModule.PrinterTypes;
  console.log('Thermal printer library loaded');
} catch (error) {
  console.log('Thermal printer library not available:', error.message);
}

// Create system tray
function createTray() {
  // Create tray icon - you might want to create a proper icon file
  // For now, create a simple icon or use a default one
  let trayIcon;
  
  try {
    // Try to load custom icon first
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
    } else {
      // Create a simple icon programmatically
      trayIcon = nativeImage.createEmpty();
    }
  } catch (error) {
    console.log('Could not load tray icon, using default');
    trayIcon = nativeImage.createEmpty();
  }
  
  tray = new Tray(trayIcon);
  
  // Create context menu for tray
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show ProteusERP Helper',
      click: () => {
        showWindow();
      }
    },
    {
      label: 'Hide Window',
      click: () => {
        hideWindow();
      }
    },
    { type: 'separator' },
    {
      label: 'Status',
      submenu: [
        {
          label: 'WebSocket Server: Running',
          enabled: false
        },
        {
          label: 'Port: 8012',
          enabled: false
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Quick Actions',
      submenu: [
        {
          label: 'Test Print',
          click: async () => {
            // You could implement quick test print here
            console.log('Quick test print requested');
          }
        },
        {
          label: 'Open Cash Drawer',
          click: async () => {
            // You could implement quick drawer open here
            console.log('Quick drawer open requested');
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Quit ProteusERP Helper',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
  tray.setToolTip('ProteusERP POS Companion');
  
  // Double-click to show/hide window
  tray.on('double-click', () => {
    if (mainWindow.isVisible()) {
      hideWindow();
    } else {
      showWindow();
    }
  });
  
  console.log('System tray created');
}

// WebSocket print function that uses the same logic as working test print
async function attemptWebSocketPrint(printerName, content) {
  console.log('=== WEBSOCKET PRINT EXECUTION ===');
  console.log('Using printer:', printerName);
  console.log('Original content length:', content.length);
  console.log('Original content (first 200 chars):', content.substring(0, 200));
  
  // Detect if content is HTML
  const isHTML = content.trim().toLowerCase().includes('<html') || 
                 content.trim().toLowerCase().includes('<!doctype') ||
                 content.includes('<body') || 
                 content.includes('<div') || 
                 content.includes('<p>') ||
                 content.includes('<table');
  
  console.log('Content type detected:', isHTML ? 'HTML' : 'Plain Text');
  
  if (isHTML) {
    // Print HTML directly - much better formatting
    return await printHTMLDirectly(printerName, content);
  } else {
    // Process plain text as before
    return await printPlainText(printerName, content);
  }
}

// Print HTML directly using Electron's print functionality - Fixed version
async function printHTMLDirectly(printerName, htmlContent) {
  console.log('=== DIRECT HTML PRINTING ===');
  console.log('Printing HTML directly to printer:', printerName);
  
  try {
    const { BrowserWindow } = require('electron');
    
    // Create a print window optimized for receipt printing
    const printWindow = new BrowserWindow({
      width: 320,  // Receipt width in pixels
      height: 600,
      show: false, // Don't show the window
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false // Allow data URLs
      }
    });
    
    // Optimize HTML for receipt printing with precise CSS
    let optimizedHTML = htmlContent;
    
    // If it's not a complete HTML document, wrap it properly
    if (!htmlContent.toLowerCase().includes('<html')) {
      optimizedHTML = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            @page {
              size: 80mm auto;
              margin: 3mm;
            }
            @media print {
              html, body {
                width: 74mm !important;
                max-width: 74mm !important;
                margin: 0 !important;
                padding: 3mm !important;
                font-family: 'Courier New', monospace !important;
                font-size: 12px !important;
                line-height: 1.3 !important;
                color: black !important;
                background: white !important;
                box-sizing: border-box !important;
              }
            }
            body { 
              font-family: 'Courier New', monospace; 
              font-size: 12px; 
              margin: 0; 
              padding: 3mm; 
              width: 74mm;
              max-width: 74mm;
              line-height: 1.3;
              color: black;
              background: white;
              box-sizing: border-box;
            }
            table { 
              width: 100% !important;
              max-width: 74mm !important;
              border-collapse: collapse; 
              margin: 2px 0;
              font-size: 12px;
              box-sizing: border-box;
            }
            th, td { 
              padding: 1px; 
              text-align: left;
              border: none;
              vertical-align: top;
              font-size: 12px;
              word-wrap: break-word;
            }
            .right { 
              text-align: right; 
            }
            .center { 
              text-align: center; 
            }
            .bold { 
              font-weight: bold; 
            }
            .receipt-header { 
              text-align: center; 
              font-weight: bold; 
              margin-bottom: 3px;
              font-size: 14px;
            }
            .receipt-line { 
              border-bottom: 1px dashed #000; 
              margin: 2px 0; 
              height: 1px;
              width: 100%;
            }
            .total-line { 
              border-top: 1px solid #000; 
              padding-top: 2px; 
              font-weight: bold;
              font-size: 13px;
            }
            p, div {
              margin: 1px 0;
              font-size: 12px;
              max-width: 74mm;
              word-wrap: break-word;
            }
            h1, h2, h3 {
              font-size: 14px;
              margin: 2px 0;
              text-align: center;
            }
          </style>
        </head>
        <body>
          ${htmlContent}
        </body>
        </html>
      `;
    } else {
      // Add receipt CSS to existing HTML
      const receiptCSS = `
        <style>
          @page { size: 80mm auto; margin: 0; }
          body { font-family: 'Courier New', monospace; font-size: 16px; margin: 0; padding: 4mm; width: 72mm; line-height: 1.3; }
          table { width: 100%; border-collapse: collapse; margin: 2px 0; font-size: 16px; }
          th, td { padding: 2px 1px; text-align: left; border: none; font-size: 16px; }
          .right { text-align: right; }
          .center { text-align: center; }
          .bold { font-weight: bold; }
          .receipt-header { text-align: center; font-weight: bold; margin-bottom: 4px; font-size: 18px; }
          .receipt-line { border-bottom: 1px dashed #000; margin: 3px 0; height: 1px; }
          .total-line { border-top: 2px solid #000; padding-top: 3px; font-weight: bold; font-size: 18px; }
          p, div { margin: 2px 0; font-size: 16px; }
          h1, h2, h3 { font-size: 20px; margin: 3px 0; }
        </style>
      `;
      
      if (optimizedHTML.toLowerCase().includes('</head>')) {
        optimizedHTML = optimizedHTML.replace('</head>', receiptCSS + '</head>');
      } else {
        optimizedHTML = receiptCSS + optimizedHTML;
      }
    }
    
    console.log('HTML optimized for receipt printing');
    
    // Load the HTML with a promise that has proper error handling
    console.log('Loading HTML into print window...');
    
    await new Promise((resolve, reject) => {
      let resolved = false;
      
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('HTML loading timed out after 5 seconds'));
        }
      }, 5000);
      
      printWindow.webContents.once('did-finish-load', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          console.log('HTML loaded successfully');
          resolve();
        }
      });
      
      printWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to load HTML: ${errorDescription} (${errorCode})`));
        }
      });
      
      // Load the HTML
      try {
        const dataURL = `data:text/html;charset=utf-8,${encodeURIComponent(optimizedHTML)}`;
        console.log('Loading data URL, length:', dataURL.length);
        printWindow.loadURL(dataURL);
      } catch (loadError) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(loadError);
        }
      }
    });
    
    // Small delay to ensure rendering is complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('Starting print operation...');
    
    // Print with proper options for thermal printer
    const printResult = await new Promise((resolve, reject) => {
      let resolved = false;
      
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Print operation timed out after 10 seconds'));
        }
      }, 10000);
      
      const printOptions = {
        silent: true,
        printBackground: false,
        color: false,
        deviceName: printerName,
        margins: {
          marginType: 'none'
        },
        landscape: false,
        pagesPerSheet: 1,
        collate: false,
        copies: 1,
        header: '',
        footer: '',
        pageSize: 'A4',
        dpi: {
          horizontal: 203,
          vertical: 203
        }
      };
      
      console.log('Print options:', JSON.stringify(printOptions, null, 2));
      
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          
          console.log('Print callback executed');
          console.log('Success:', success);
          console.log('Failure reason:', failureReason);
          
          if (success) {
            resolve(true);
          } else {
            reject(new Error(failureReason || 'Print operation failed'));
          }
        }
      });
    });
    
    // Clean up
    printWindow.close();
    console.log('Print window closed');
    
    console.log('HTML printing completed successfully');
    
    return { 
      success: true, 
      data: { message: `HTML printed successfully to ${printerName}` }
    };
    
  } catch (error) {
    console.error('Direct HTML printing failed:', error.message);
    console.log('Falling back to text conversion...');
    
    // Fallback to text conversion
    const textContent = await processHTMLForPrinting(htmlContent);
    return await printPlainText(printerName, textContent);
  }
}

// Print plain text (original working method)
async function printPlainText(printerName, content) {
  console.log('=== PLAIN TEXT PRINTING ===');
  console.log('Using printer:', printerName);
  
  let processedContent = content;
  
  // Add proper line endings for Windows printing
  if (process.platform === 'win32') {
    // Ensure Windows line endings (CRLF)
    processedContent = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    
    // Add form feed at the end to ensure page ejects
    if (!processedContent.endsWith('\f')) {
      processedContent += '\r\n\f';
    }
  }
  
  console.log('Processed content length:', processedContent.length);
  
  // Use app.getPath('temp') for better cross-platform temp directory
  const { app } = require('electron');
  const tempDir = app.getPath('temp');
  const tempFile = path.join(tempDir, 'proteus_websocket_' + Date.now() + '.txt');
  
  try {
    // Write content to temp file with explicit encoding
    fs.writeFileSync(tempFile, processedContent, { encoding: 'utf8' });
    console.log('Plain text temp file created:', tempFile);
    
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        // Use the same PowerShell method that works for test print
        const escapedPrinter = printerName.replace(/'/g, "''");
        const escapedFile = tempFile.replace(/\\/g, '/');
        const psCommand = `powershell -Command "Get-Content '${escapedFile}' -Encoding UTF8 | Out-Printer -Name '${escapedPrinter}'"`;
        
        console.log('Plain text using PowerShell command:', psCommand);
        
        exec(psCommand, { timeout: 15000 }, (error, stdout, stderr) => {
          // Clean up temp file
          try {
            fs.unlinkSync(tempFile);
            console.log('Plain text temp file cleaned up');
          } catch (e) {
            console.warn('Could not delete temp file:', e.message);
          }
          
          console.log('Plain text PowerShell result:');
          console.log('Error:', error);
          console.log('Stdout:', stdout);
          console.log('Stderr:', stderr);
          
          if (error) {
            resolve({ 
              success: false, 
              error: `Plain text print failed: ${error.message}`,
              debug: { stdout, stderr, command: psCommand, printerName, tempFile }
            });
          } else {
            resolve({ 
              success: true, 
              data: { message: `Plain text print job sent successfully to ${printerName}` }
            });
          }
        });
      } else {
        // Non-Windows platforms
        const printCommand = `lpr -P "${printerName}" "${tempFile}"`;
        console.log('Plain text using lpr command:', printCommand);
        
        exec(printCommand, (error, stdout, stderr) => {
          try {
            fs.unlinkSync(tempFile);
          } catch (e) {
            console.warn('Could not delete temp file:', e.message);
          }
          
          if (error) {
            resolve({ success: false, error: `Plain text print failed: ${error.message}` });
          } else {
            resolve({ success: true, data: { message: 'Plain text print sent successfully' } });
          }
        });
      }
    });
  } catch (fileError) {
    return { success: false, error: `Plain text print - failed to create temp file: ${fileError.message}` };
  }
}

// Process HTML content for printing - Optimized for full receipt width
async function processHTMLForPrinting(htmlContent) {
  console.log('=== HTML PROCESSING ===');
  console.log('Processing HTML content for printing...');
  
  try {
    // Simple HTML to text conversion optimized for receipt width (about 48 characters)
    let textContent = htmlContent;
    
    // Remove DOCTYPE and html/head tags
    textContent = textContent.replace(/<!DOCTYPE[^>]*>/gi, '');
    textContent = textContent.replace(/<html[^>]*>/gi, '');
    textContent = textContent.replace(/<\/html>/gi, '');
    textContent = textContent.replace(/<head[^>]*>.*?<\/head>/gis, '');
    
    // Remove script and style elements
    textContent = textContent.replace(/<script[^>]*>.*?<\/script>/gis, '');
    textContent = textContent.replace(/<style[^>]*>.*?<\/style>/gis, '');
    
    // Handle receipt header specifically
    textContent = textContent.replace(/<div[^>]*class="[^"]*receipt-header[^"]*"[^>]*>(.*?)<\/div>/gis, (match, content) => {
      // Extract all text from nested divs
      let headerLines = [];
      const divMatches = content.match(/<div[^>]*class="[^"]*bold[^"]*"[^>]*>(.*?)<\/div>/gis);
      if (divMatches) {
        divMatches.forEach(div => {
          const text = div.replace(/<[^>]+>/g, '').trim();
          if (text) headerLines.push(text);
        });
      }
      
      // Also get regular divs
      const regularDivs = content.match(/<div[^>]*>(.*?)<\/div>/gis);
      if (regularDivs) {
        regularDivs.forEach(div => {
          const text = div.replace(/<[^>]+>/g, '').trim();
          if (text && !headerLines.includes(text)) {
            headerLines.push(text);
          }
        });
      }
      
      // Center each line
      let result = '\n';
      headerLines.forEach(line => {
        const padding = Math.floor((48 - line.length) / 2);
        result += ' '.repeat(Math.max(0, padding)) + line + '\n';
      });
      
      return result;
    });
    
    // Handle receipt lines as dashes across full width
    textContent = textContent.replace(/<div[^>]*class="[^"]*receipt-line[^"]*"[^>]*><\/div>/gi, '\n' + '='.repeat(48) + '\n');
    
    // Process tables with better formatting
    textContent = textContent.replace(/<table[^>]*>(.*?)<\/table>/gis, (match, tableContent) => {
      let tableText = '\n';
      
      // Extract rows
      const rowMatches = tableContent.match(/<tr[^>]*>(.*?)<\/tr>/gis) || [];
      
      rowMatches.forEach(rowMatch => {
        // Extract cells from each row
        const cellMatches = rowMatch.match(/<td[^>]*>(.*?)<\/td>/gis) || [];
        
        if (cellMatches.length === 2) {
          // Two column layout - left and right
          const leftContent = cellMatches[0].replace(/<[^>]+>/g, '').trim();
          const rightContent = cellMatches[1].replace(/<[^>]+>/g, '').trim();
          
          // Check if right column has 'right' class for right alignment
          const isRightAligned = cellMatches[1].includes('class="right"') || 
                                cellMatches[1].includes('class="[^"]*right[^"]*"');
          
          if (isRightAligned) {
            // Right-aligned: item name ... price
            const maxLeftWidth = 32;
            const truncatedLeft = leftContent.length > maxLeftWidth ? 
                                 leftContent.substring(0, maxLeftWidth-3) + '...' : 
                                 leftContent;
            
            const totalWidth = 48;
            const padding = totalWidth - truncatedLeft.length - rightContent.length;
            const spaces = Math.max(1, padding);
            
            tableText += truncatedLeft + ' '.repeat(spaces) + rightContent + '\n';
          } else {
            // Regular two-column
            tableText += leftContent.padEnd(24, ' ') + rightContent + '\n';
          }
        } else if (cellMatches.length === 1) {
          // Single column
          const content = cellMatches[0].replace(/<[^>]+>/g, '').trim();
          
          // Check for special styling
          if (cellMatches[0].includes('padding-left: 20px') || cellMatches[0].includes('font-size: 10px')) {
            // Indented sub-item
            tableText += '    ' + content + '\n';
          } else {
            tableText += content + '\n';
          }
        } else {
          // Multiple columns - distribute evenly
          const cellTexts = cellMatches.map(cellMatch => {
            const cellText = cellMatch.replace(/<[^>]+>/g, '').trim();
            const cellWidth = Math.floor(48 / cellMatches.length) - 1;
            return cellText.length > cellWidth ? 
                   cellText.substring(0, cellWidth-3) + '...' : 
                   cellText.padEnd(cellWidth, ' ');
          });
          
          tableText += cellTexts.join(' ') + '\n';
        }
      });
      
      return tableText;
    });
    
    // Handle total lines with emphasis
    textContent = textContent.replace(/<table[^>]*class="[^"]*total-line[^"]*"[^>]*>(.*?)<\/table>/gis, (match, content) => {
      const rowMatch = content.match(/<tr[^>]*class="[^"]*bold[^"]*"[^>]*>(.*?)<\/tr>/gis);
      if (rowMatch) {
        const cellMatches = rowMatch[0].match(/<td[^>]*>(.*?)<\/td>/gis) || [];
        if (cellMatches.length === 2) {
          const leftContent = cellMatches[0].replace(/<[^>]+>/g, '').trim();
          const rightContent = cellMatches[1].replace(/<[^>]+>/g, '').trim();
          
          const padding = 48 - leftContent.length - rightContent.length;
          const spaces = Math.max(1, padding);
          
          return '\n' + '-'.repeat(48) + '\n' + 
                 leftContent + ' '.repeat(spaces) + rightContent + '\n';
        }
      }
      return '\n' + content.replace(/<[^>]+>/g, '') + '\n';
    });
    
    // Handle paragraphs in center sections
    textContent = textContent.replace(/<div[^>]*class="[^"]*center[^"]*bold[^"]*"[^>]*>(.*?)<\/div>/gis, (match, content) => {
      let result = '\n';
      const pMatches = content.match(/<p[^>]*>(.*?)<\/p>/gis) || [];
      pMatches.forEach(p => {
        const text = p.replace(/<[^>]+>/g, '').trim();
        if (text) {
          const padding = Math.floor((48 - text.length) / 2);
          result += ' '.repeat(Math.max(0, padding)) + text + '\n';
        }
      });
      return result;
    });
    
    // Handle common block elements
    textContent = textContent.replace(/<br\s*\/?>/gi, '\n');
    textContent = textContent.replace(/<\/?(div|p|h[1-6])[^>]*>/gi, '\n');
    textContent = textContent.replace(/<hr\s*\/?>/gi, '\n' + '-'.repeat(48) + '\n');
    
    // Handle lists
    textContent = textContent.replace(/<li[^>]*>/gi, '• ');
    textContent = textContent.replace(/<\/li>/gi, '\n');
    textContent = textContent.replace(/<\/?[ou]l[^>]*>/gi, '\n');
    
    // Remove all remaining HTML tags
    textContent = textContent.replace(/<[^>]+>/g, '');
    
    // Decode HTML entities
    textContent = textContent.replace(/&nbsp;/g, ' ');
    textContent = textContent.replace(/&amp;/g, '&');
    textContent = textContent.replace(/&lt;/g, '<');
    textContent = textContent.replace(/&gt;/g, '>');
    textContent = textContent.replace(/&quot;/g, '"');
    textContent = textContent.replace(/&#39;/g, "'");
    textContent = textContent.replace(/&apos;/g, "'");
    
    // Clean up whitespace and line breaks
    textContent = textContent.replace(/\s*\n\s*/g, '\n');  // Normalize line breaks
    textContent = textContent.replace(/\n{3,}/g, '\n\n');   // Remove excessive line breaks
    textContent = textContent.replace(/^\s+|\s+$/g, '');     // Trim whitespace
    textContent = textContent.replace(/\t/g, '    ');        // Convert tabs to spaces
    
    console.log('HTML to text conversion completed');
    console.log('Extracted text length:', textContent.length);
    console.log('Extracted text preview (first 500 chars):');
    console.log(textContent.substring(0, 500));
    
    return textContent;
    
  } catch (error) {
    console.error('Error processing HTML:', error);
    
    // Ultimate fallback - just strip all HTML tags
    console.log('Using ultimate fallback HTML processing...');
    let fallbackText = htmlContent
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    
    console.log('Fallback processing completed');
    return fallbackText;
  }
}

// Show window function
function showWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
}

// Hide window function
function hideWindow() {
  if (mainWindow) {
    mainWindow.hide();
  }
}

// Check if app should start hidden
function shouldStartHidden() {
  // Check command line arguments
  const args = process.argv;
  return args.includes('--hidden') || args.includes('--background') || args.includes('--startup');
}

// Update your createWindow function
function createWindow() {
    const startHidden = shouldStartHidden();
    
    // Create the browser window
    mainWindow = new BrowserWindow({
      width: 400,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true
      },
      title: 'ProteusERP Helper',
      resizable: false,
      minimizable: true,
      maximizable: false,
      show: !startHidden // Don't show if starting hidden
    });
  
    // Load the index.html of the app
    mainWindow.loadFile('index.html');
  
    // Hide menu bar
    mainWindow.setMenuBarVisibility(false);
  
    // Handle window close - minimize to tray instead of closing
    mainWindow.on('close', (event) => {
      if (!app.isQuiting) {
        event.preventDefault();
        hideWindow();
        
        // Show notification on first minimize
        if (!mainWindow.wasMinimizedToTray) {
          tray.displayBalloon({
            iconType: 'info',
            title: 'ProteusERP Helper',
            content: 'Application was minimized to tray. Right-click the tray icon to access options.'
          });
          mainWindow.wasMinimizedToTray = true;
        }
      }
    });
    
    // Handle minimize - also hide to tray
    mainWindow.on('minimize', (event) => {
      event.preventDefault();
      hideWindow();
    });
    
    // If starting hidden, don't show the window
    if (!startHidden) {
      mainWindow.show();
    } else {
      console.log('Starting in background mode');
      // Show a brief notification that the app started
      setTimeout(() => {
        if (tray) {
          tray.displayBalloon({
            iconType: 'info',
            title: 'ProteusERP Helper Started',
            content: 'POS Companion is running in the background. Right-click the tray icon to access options.'
          });
        }
      }, 2000);
    }
  }

// Connection status monitoring
function updateConnectionStatus() {
  const connectedClients = wsServer ? wsServer.clients.size : 0;
  
  // Update tray tooltip with real status
  if (tray) {
    if (connectedClients > 0) {
      tray.setToolTip(`ProteusERP POS Companion - ${connectedClients} client(s) connected`);
    } else {
      tray.setToolTip('ProteusERP POS Companion - Waiting for connections');
    }
  }
  
  // Send status to renderer if window exists
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('connection-status-update', {
      clients: connectedClients,
      serverRunning: !!wsServer
    });
  }
}

// Initialize WebSocket server for POS communication
function initializeWebSocketServer() {
  wsServer = new WebSocket.Server({ port: 8012 });
  
    wsServer.on('connection', (ws) => {
        console.log('POS system connected');
        updateConnectionStatus(); // Update status immediately
        
        ws.on('message', async (message) => {
        try {
            console.log('Raw message received:', message.toString());
            const data = JSON.parse(message);
            console.log('Parsed message:', JSON.stringify(data, null, 2));
            
            let response = { success: false, error: null, data: null };
            
            switch (data.action) {
            case 'print':
                console.log('Handling print action...');
                // Use the same working print method as test print
                response = await attemptWebSocketPrint(data.printer, data.content);
                break;
            case 'openCashDrawer':
                console.log('Handling openCashDrawer action...');
                response = await handleCashDrawer(data);
                break;
            case 'getPrinters':
                console.log('Handling getPrinters action...');
                response = await getPrinters();
                break;
            case 'getConfiguration':
                console.log('Handling getConfiguration action...');
                response = await getConfiguration();
                console.log('getConfiguration response:', JSON.stringify(response, null, 2));
                break;
            case 'getStatus':
                console.log('Handling getStatus action...');
                response = { success: true, data: { status: 'ready', version: '1.0.0' } };
                break;
            case 'getScanners':
                console.log('Handling getScanners action...');
                response = await scannerService.detectScanners();
                break;
            case 'scan':
                console.log('Handling scan action...');
                response = await handleScanRequest(data);
                break;
            case 'scanAndUpload':
                console.log('Handling scanAndUpload action...');
                response = await handleScanAndUpload(data);
                break;
            case 'scanToFolder':
                console.log('Handling scanToFolder action...');
                response = await handleScanToFolder(data);
                break;
            case 'getScanSettings':
                console.log('Handling getScanSettings action...');
                response = { success: true, data: scannerService.getScanSettings() };
                break;
            case 'updateScanSettings':
                console.log('Handling updateScanSettings action...');
                scannerService.updateScanSettings(data.settings || {});
                response = { success: true, data: scannerService.getScanSettings() };
                break;
            // Transaction Queue Actions
            case 'submitTransaction':
                console.log('Handling submitTransaction action...');
                response = await transactionQueueService.submitTransaction({
                    idempotencyKey: data.idempotencyKey,
                    type: data.type,
                    data: data.data
                });
                break;
            case 'getQueueStatus':
                console.log('Handling getQueueStatus action...');
                response = await transactionQueueService.getQueueStatus();
                break;
            case 'retryQueue':
                console.log('Handling retryQueue action...');
                response = await transactionQueueService.processQueue();
                response.success = true;
                break;
            case 'getQueuedTransactions':
                console.log('Handling getQueuedTransactions action...');
                response = await transactionQueueService.getQueuedTransactions(data.limit || 50);
                break;
            case 'cancelTransaction':
                console.log('Handling cancelTransaction action...');
                response = await transactionQueueService.cancelTransaction(data.transactionId);
                break;
            case 'retryTransaction':
                console.log('Handling retryTransaction action...');
                response = await transactionQueueService.retryTransaction(data.transactionId);
                break;
            default:
                console.log('Unknown action:', data.action);
                response = { success: false, error: 'Unknown action: ' + data.action };
            }
            
            console.log('Sending response:', JSON.stringify(response, null, 2));
            ws.send(JSON.stringify(response));
        } catch (error) {
            console.error('Error processing message:', error);
            const errorResponse = { success: false, error: error.message };
            console.log('Sending error response:', JSON.stringify(errorResponse, null, 2));
            ws.send(JSON.stringify(errorResponse));
        }
        });
        
        ws.on('close', () => {
        console.log('POS system disconnected');
        updateConnectionStatus(); // Update status when disconnected
        });
        
        ws.on('error', (error) => {
        console.error('WebSocket connection error:', error);
        });
    });
  
  console.log('WebSocket server started on port 8012');
  
  // Start connection monitoring every 5 seconds
  setInterval(updateConnectionStatus, 5000);
}

// Handle scan request via WebSocket
async function handleScanRequest(data) {
  try {
    const scannerId = data.scannerId || data.scanner;
    const options = data.options || {};
    
    if (!scannerId) {
      return { success: false, error: 'Scanner ID is required for scanning' };
    }
    
    console.log(`Scanning with device: ${scannerId}`);
    console.log('Scan options:', options);
    
    const result = await scannerService.performScan(scannerId, options);
    
    if (result.success) {
      console.log('Scan completed successfully');
      return {
        success: true,
        data: {
          ...result.data,
          message: 'Document scanned successfully'
        }
      };
    } else {
      console.error('Scan failed:', result.error);
      return result;
    }
    
  } catch (error) {
    console.error('Error in handleScanRequest:', error);
    return { success: false, error: error.message };
  }
}

// Handle scan and upload request via WebSocket
async function handleScanAndUpload(data) {
  try {
    const scannerId = data.scannerId || data.scanner;
    const options = data.options || {};
    const metadata = data.metadata || {};
    
    if (!scannerId) {
      return { success: false, error: 'Scanner ID is required for scanning' };
    }
    
    // Get API configuration
    const config = await getConfiguration();
    if (!config.success || !config.data.apiBaseUrl) {
      return { success: false, error: 'API configuration not found. Please configure API settings first.' };
    }
    
    const apiKey = config.data.apiKey || data.apiKey;
    if (!apiKey) {
      return { success: false, error: 'API key not found. Please configure API settings first.' };
    }
    
    console.log(`Scanning and uploading with device: ${scannerId}`);
    
    // Step 1: Perform scan
    const scanResult = await scannerService.performScan(scannerId, options);
    if (!scanResult.success) {
      return scanResult;
    }
    
    console.log('Scan completed, now uploading to SaaS...');
    
    // Step 2: Upload to SaaS
    const uploadResult = await scannerService.uploadToSaaS(
      scanResult.data.filepath,
      config.data.apiBaseUrl,
      apiKey,
      {
        ...metadata,
        scanner_id: scannerId,
        scan_settings: options
      }
    );
    
    if (uploadResult.success) {
      return {
        success: true,
        data: {
          scan: scanResult.data,
          upload: uploadResult.data,
          message: 'Document scanned and uploaded successfully'
        }
      };
    } else {
      // Scan succeeded but upload failed - return both results
      return {
        success: false,
        error: `Scan completed but upload failed: ${uploadResult.error}`,
        data: {
          scan: scanResult.data,
          upload_error: uploadResult.error
        }
      };
    }
    
  } catch (error) {
    console.error('Error in handleScanAndUpload:', error);
    return { success: false, error: error.message };
  }
}

// Handle scan to folder request from web application
async function handleScanToFolder(data) {
  try {
    let scannerId = data.scannerId;
    
    // Auto-select scanner if not specified
    if (!scannerId || scannerId === 'auto') {
      const scannersResult = await scannerService.detectScanners();
      if (scannersResult.success && scannersResult.scanners.length > 0) {
        // Prefer non-virtual scanners, fallback to virtual
        const realScanner = scannersResult.scanners.find(s => !s.name.includes('Virtual'));
        scannerId = realScanner ? realScanner.id : scannersResult.scanners[0].id;
        console.log(`Auto-selected scanner: ${scannerId}`);
      } else {
        return { success: false, error: 'No scanners available for auto-selection' };
      }
    }
    
    const options = data.options || {};
    const folderMetadata = {
      ...data.metadata,
      source: 'web_application',
      scan_trigger: 'folder_context',
      folderId: data.folderId || data.metadata?.folderId,
      folderName: data.folderName || data.metadata?.folderName
    };
    
    console.log(`Scanning to folder: ${folderMetadata.folderName} (ID: ${folderMetadata.folderId})`);
    
    // Get API configuration
    const config = await getConfiguration();
    if (!config.success || !config.data.apiBaseUrl) {
      return { success: false, error: 'API configuration not found. Please configure API settings first.' };
    }
    
    // Get API key from config file
    let apiKey = null;
    try {
      const configFilePath = getConfigPath();
      const configData = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      apiKey = configData.apiKey;
    } catch (error) {
      console.log('Could not read API key from config:', error.message);
    }
    
    if (!apiKey) {
      return { success: false, error: 'API key not found. Please configure API settings first in the application.' };
    }
    
    // Perform scan
    const scanResult = await scannerService.performScan(scannerId, options);
    if (!scanResult.success) {
      return scanResult;
    }
    
    console.log('Scan completed, uploading to folder context...');
    
    // Upload to SaaS with folder context
    const uploadResult = await scannerService.uploadToSaaS(
      scanResult.data.filepath,
      config.data.apiBaseUrl,
      apiKey,
      folderMetadata
    );
    
    if (uploadResult.success) {
      return {
        success: true,
        data: {
          scan: scanResult.data,
          upload: uploadResult.data,
          folder: {
            id: folderMetadata.folderId,
            name: folderMetadata.folderName
          },
          message: `Document scanned and uploaded to folder: ${folderMetadata.folderName}`
        }
      };
    } else {
      return {
        success: false,
        error: `Scan completed but upload failed: ${uploadResult.error}`,
        data: {
          scan: scanResult.data,
          upload_error: uploadResult.error
        }
      };
    }
    
  } catch (error) {
    console.error('Error in handleScanToFolder:', error);
    return { success: false, error: error.message };
  }
}

// Enhanced error handling for print operations
async function handlePrint(data) {
  try {
    const printer = data.printer;
    const content = data.content;
    const options = data.options || {};
    
    if (!printer || !content) {
      return { success: false, error: 'Printer name and content are required for printing' };
    }
    
    console.log('Attempting to print to: ' + printer);
    console.log('Content length: ' + content.length + ' characters');
    
    // Validate printer name
    if (printer.length > 100) {
      return { success: false, error: 'Printer name is too long (max 100 characters)' };
    }
    
    // Create temporary file for printing using system temp directory
    const { app } = require('electron');
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, 'proteus_print_' + Date.now() + '.txt');
    
    // Write content to temp file with proper encoding
    try {
      fs.writeFileSync(tempFile, content, 'utf8');
    } catch (writeError) {
      return { success: false, error: 'Failed to write print content to file: ' + writeError.message };
    }
    
    // Print based on platform with better error handling
    let printCommand;
    if (process.platform === 'win32') {
      // Try multiple Windows printing methods
      
      // Method 1: Simple notepad print (most reliable)
      const simpleCommand = `notepad /p "${tempFile}"`;
      console.log('Trying simple notepad print method first:', simpleCommand);
      
      try {
        await new Promise((resolve, reject) => {
          exec(simpleCommand, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
              console.log('Notepad method failed, trying PowerShell...');
              reject(error);
            } else {
              console.log('Notepad print method succeeded');
              resolve();
            }
          });
        });
        
        // If notepad method worked, clean up and return success
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          console.warn('Could not delete temp file:', e.message);
        }
        
        return { success: true, data: { message: 'Print job sent via notepad method' } };
        
      } catch (notepadError) {
        console.log('Notepad method failed, continuing with PowerShell method');
      }
      
      // Method 2: PowerShell method
      const escapedPrinter = printer.replace(/'/g, "''").replace(/"/g, '`"');
      printCommand = 'powershell -Command "Get-Content \'' + tempFile.replace(/\\/g, '/') + '\' | Out-Printer -Name \'' + escapedPrinter + '\'"';
      
    } else if (process.platform === 'darwin') {
      // macOS
      printCommand = 'lpr -P "' + printer + '" "' + tempFile + '"';
    } else {
      // Linux
      printCommand = 'lpr -P "' + printer + '" "' + tempFile + '"';
    }
    
    console.log('Executing print command: ' + printCommand);
    
    return new Promise((resolve) => {
      exec(printCommand, { timeout: 15000 }, (error, stdout, stderr) => {
        console.log('Print command completed');
        console.log('Exit code:', error ? error.code : 0);
        if (stdout) console.log('STDOUT:', stdout);
        if (stderr) console.log('STDERR:', stderr);
        
        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
          console.log('Cleaned up temp file:', tempFile);
        } catch (e) {
          console.warn('Could not delete temp file:', e.message);
        }
        
        if (error) {
          console.error('Print error:', error);
          console.error('Error code:', error.code);
          console.error('Error signal:', error.signal);
          
          // Try alternative method on Windows if first fails
          if (process.platform === 'win32' && error.code === 1) {
            console.log('Trying alternative Windows print method...');
            const altTempFile = path.join(__dirname, 'temp', 'print_alt_' + Date.now() + '.txt');
            fs.writeFileSync(altTempFile, content, 'utf8');
            
            // Try the old print command as fallback
            const altCommand = 'print /D:"' + printer + '" "' + altTempFile + '"';
            console.log('Trying fallback command: ' + altCommand);
            
            exec(altCommand, (altError, altStdout, altStderr) => {
              try {
                fs.unlinkSync(altTempFile);
              } catch (e) {
                console.warn('Could not delete alt temp file:', e.message);
              }
              
              if (altError) {
                // Try one more method: copy command
                console.log('Trying copy method...');
                const copyTempFile = path.join(__dirname, 'temp', 'print_copy_' + Date.now() + '.txt');
                fs.writeFileSync(copyTempFile, content, 'utf8');
                
                const copyCommand = 'copy "' + copyTempFile + '" "' + printer + '"';
                exec(copyCommand, (copyError, copyStdout, copyStderr) => {
                  try {
                    fs.unlinkSync(copyTempFile);
                  } catch (e) {
                    console.warn('Could not delete copy temp file:', e.message);
                  }
                  
                  if (copyError) {
                    resolve({ 
                      success: false, 
                      error: 'All print methods failed. PowerShell: ' + error.message + '. Print command: ' + altError.message + '. Copy: ' + copyError.message
                    });
                  } else {
                    resolve({ success: true, data: { message: 'Print job sent via copy method' } });
                  }
                });
              } else {
                resolve({ success: true, data: { message: 'Print job sent via print command' } });
              }
            });
            return;
          }
          
          resolve({ 
            success: false, 
            error: 'Print failed: ' + error.message + '. Code: ' + error.code + '. Signal: ' + error.signal
          });
        } else {
          console.log('Print job sent successfully');
          resolve({ success: true, data: { message: 'Print job sent successfully' } });
        }
      });
    });
  } catch (error) {
    console.error('Exception in handlePrint:', error);
    return { success: false, error: error.message };
  }
}

// Alternative Windows printing method using WMI
async function handleWindowsWMIPrint(data) {
  try {
    const printer = data.printer;
    const content = data.content;
    
    if (process.platform !== 'win32') {
      return { success: false, error: 'WMI printing only available on Windows' };
    }
    
    // Create temp file
    const tempFile = path.join(__dirname, 'temp', 'wmi_print_' + Date.now() + '.txt');
    const tempDir = path.dirname(tempFile);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    fs.writeFileSync(tempFile, content, 'utf8');
    
    // Use a simpler PowerShell approach
    const escapedPrinter = printer.replace(/'/g, "''");
    const escapedFile = tempFile.replace(/\\/g, '/');
    
    const command = 'powershell -Command "& {Get-Content \'' + escapedFile + '\' | Out-Printer -Name \'' + escapedPrinter + '\'}"';
    
    return new Promise((resolve) => {
      exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
        // Clean up files
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          console.warn('Could not delete temp file:', e.message);
        }
        
        if (error) {
          console.error('WMI print error:', error);
          resolve({ success: false, error: error.message });
        } else {
          console.log('WMI print completed');
          resolve({ success: true, data: { message: 'Print job sent via WMI' } });
        }
      });
    });
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Handle cash drawer opening
async function handleCashDrawer(data) {
  try {
    const printer = data.printer;
    
    if (!printer) {
      return { success: false, error: 'Printer is required for cash drawer' };
    }
    
    // ESC/POS command to open cash drawer
    const drawerCommand = Buffer.from([0x1B, 0x70, 0x00, 0x19, 0xFA]);
    
    // Create temporary file with drawer command using system temp directory
    const { app } = require('electron');
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, 'proteus_drawer_' + Date.now() + '.bin');
    
    fs.writeFileSync(tempFile, drawerCommand);
    
    // Send to printer
    let printCommand;
    if (process.platform === 'win32') {
      printCommand = 'copy /b "' + tempFile + '" "' + printer + '"';
    } else {
      printCommand = 'cat "' + tempFile + '" > "' + printer + '"';
    }
    
    return new Promise((resolve) => {
      exec(printCommand, (error, stdout, stderr) => {
        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          console.warn('Could not delete temp file:', e.message);
        }
        
        if (error) {
          console.error('Cash drawer error:', error);
          resolve({ success: false, error: error.message });
        } else {
          console.log('Cash drawer opened successfully');
          resolve({ success: true, data: { message: 'Cash drawer opened' } });
        }
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get available printers
async function getPrinters() {
  return new Promise((resolve) => {
    let command;
    if (process.platform === 'win32') {
      // Better Windows printer detection with WorkflowStatus which is more accurate
      command = 'powershell -Command "Get-Printer | Select-Object Name,PrinterStatus,DeviceType,WorkflowStatus,Comment | ConvertTo-Json"';
    } else if (process.platform === 'darwin') {
      command = 'lpstat -p';
    } else {
      command = 'lpstat -p';
    }
    
    console.log('Getting printers with command: ' + command);
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Error getting printers:', error);
        
        // Fallback for Windows
        if (process.platform === 'win32') {
          console.log('Trying fallback Windows printer detection...');
          const fallbackCommand = 'powershell -Command "Get-Printer | Select-Object Name | ConvertTo-Json"';
          exec(fallbackCommand, (fallbackError, fallbackStdout, fallbackStderr) => {
            if (fallbackError) {
              // Final fallback using wmic
              const wmicCommand = 'wmic printer get name,status /format:csv';
              exec(wmicCommand, (wmicError, wmicStdout, wmicStderr) => {
                if (wmicError) {
                  resolve({ success: false, error: wmicError.message });
                  return;
                }
                
                let printers = [];
                const lines = wmicStdout.split('\n').filter(line => line.trim() && !line.includes('Name,Status'));
                printers = lines.map(line => {
                  const parts = line.split(',');
                  return { 
                    name: parts[1] ? parts[1].trim() : '', 
                    status: parts[2] ? parts[2].trim() : 'Ready' 
                  };
                }).filter(p => p.name);
                
                console.log('WMIC printers found:', printers);
                resolve({ success: true, data: { printers } });
              });
              return;
            }
            
            // Simple method - just get names and assume they're ready
            try {
              const simpleData = JSON.parse(fallbackStdout);
              const simpleArray = Array.isArray(simpleData) ? simpleData : [simpleData];
              
              const printers = simpleArray.map(printer => ({
                name: printer.Name,
                status: 'Ready', // Assume ready if printer is listed
                type: 'Printer'
              })).filter(p => p.name);
              
              console.log('Simple fallback printers found:', printers);
              resolve({ success: true, data: { printers } });
            } catch (parseError) {
              resolve({ success: false, error: 'Failed to parse printer data' });
            }
          });
          return;
        }
        
        resolve({ success: false, error: error.message });
        return;
      }
      
      let printers = [];
      if (process.platform === 'win32') {
        try {
          // Try to parse JSON response from PowerShell
          const printerData = JSON.parse(stdout);
          const printerArray = Array.isArray(printerData) ? printerData : [printerData];
          
          // Debug: Log raw printer data
          console.log('Raw printer data from PowerShell:', JSON.stringify(printerArray, null, 2));
          
          printers = printerArray.map(printer => {
            // Debug: Log each printer's raw status data
            console.log('Printer:', printer.Name);
            console.log('  PrinterStatus:', printer.PrinterStatus);
            console.log('  WorkflowStatus:', printer.WorkflowStatus);
            console.log('  DeviceType:', printer.DeviceType);
            console.log('  Comment:', printer.Comment);
            
            let status = 'Unknown';
            
            // Check WorkflowStatus first (most accurate for actual printer state)
            if (printer.WorkflowStatus != null) {
              console.log('  Using WorkflowStatus:', printer.WorkflowStatus);
              switch (printer.WorkflowStatus) {
                case 0:
                  status = 'Ready';
                  break;
                case 1:
                  status = 'Offline';
                  break;
                case 2:
                  status = 'Error';
                  break;
                case 3:
                  status = 'Printing';
                  break;
                case 4:
                  status = 'Processing';
                  break;
                default:
                  status = 'Workflow ' + printer.WorkflowStatus;
              }
            } else if (printer.PrinterStatus != null) {
              console.log('  Using PrinterStatus:', printer.PrinterStatus);
              // Fallback to PrinterStatus
              switch (printer.PrinterStatus) {
                case 0:
                  status = 'Ready';
                  break;
                case 1:
                  status = 'Other';
                  break;
                case 2:
                  status = 'Unknown';
                  break;
                case 3:
                  status = 'Ready';
                  break;
                case 4:
                  status = 'Printing';
                  break;
                case 5:
                  status = 'Warming Up';
                  break;
                case 6:
                  status = 'Stopped';
                  break;
                case 7:
                  status = 'Offline';
                  break;
                default:
                  status = 'Status ' + printer.PrinterStatus;
              }
            } else {
              console.log('  No status available, checking if printer responds...');
              // If no status, we'll need to assume something
              status = 'Unknown';
            }
            
            // Additional check: if Comment contains offline indicators
            if (printer.Comment && typeof printer.Comment === 'string') {
              const comment = printer.Comment.toLowerCase();
              if (comment.includes('offline') || comment.includes('not available') || comment.includes('error')) {
                status = 'Offline';
              }
            }
            
            console.log('  Final status:', status);
            
            return {
              name: printer.Name,
              status: status,
              type: printer.DeviceType || 'Unknown'
            };
          }).filter(p => p.name);
          
        } catch (parseError) {
          console.error('Error parsing printer JSON:', parseError);
          console.log('Raw output:', stdout);
          
          // Fallback parsing
          printers = [{ name: 'Default Printer', status: 'Unknown' }];
        }
      } else {
        const lines = stdout.split('\n').filter(line => line.startsWith('printer'));
        printers = lines.map(line => {
          const match = line.match(/printer (\S+)/);
          return match ? { name: match[1], status: 'available' } : null;
        }).filter(p => p);
      }
      
      console.log('Printers found:', printers);
      resolve({ success: true, data: { printers } });
    });
  });
}

// Thermal printer method (for ESC/POS printers)
async function handleThermalPrint(data) {
  if (!ThermalPrinter || !PrinterTypes) {
    return { success: false, error: 'Thermal printer library not available' };
  }
  
  try {
    const printer = data.printer;
    const content = data.content;
    
    let thermalPrinter = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: 'printer:' + printer,
      characterSet: 'SLOVENIA',
      removeSpecialCharacters: false,
      lineCharacter: "=",
    });
    
    let isConnected = await thermalPrinter.isPrinterConnected();
    if (!isConnected) {
      // Try USB interface
      thermalPrinter = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: 'usb',
        characterSet: 'SLOVENIA',
        removeSpecialCharacters: false,
        lineCharacter: "=",
      });
      isConnected = await thermalPrinter.isPrinterConnected();
    }
    
    if (!isConnected) {
      return { success: false, error: 'Could not connect to thermal printer' };
    }
    
    thermalPrinter.println(content);
    thermalPrinter.cut();
    
    await thermalPrinter.execute();
    
    return { success: true, data: { message: 'Thermal print job sent' } };
    
  } catch (error) {
    console.error('Thermal print error:', error);
    return { success: false, error: error.message };
  }
}

// Alternative print method for direct printer communication
async function handleDirectPrint(data) {
  try {
    const printer = data.printer;
    const content = data.content;
    
    if (process.platform === 'win32') {
      // For Windows, try to write directly to printer port
      
      // Common printer paths on Windows
      const printerPaths = [
        '//.//' + printer,
        '//./' + printer,
        'LPT1:',
        'COM1:'
      ];
      
      for (let i = 0; i < printerPaths.length; i++) {
        const printerPath = printerPaths[i];
        try {
          console.log('Trying direct write to: ' + printerPath);
          
          // Try to open printer as file (works for many USB receipt printers)
          const fd = fs.openSync(printerPath, 'w');
          fs.writeSync(fd, content);
          fs.closeSync(fd);
          
          console.log('Successfully wrote to ' + printerPath);
          return { success: true, data: { message: 'Printed directly to ' + printerPath } };
          
        } catch (directError) {
          console.log('Direct write to ' + printerPath + ' failed:', directError.message);
          continue;
        }
      }
      
      return { success: false, error: 'Could not write directly to any printer port' };
    }
    
    return { success: false, error: 'Direct printing only supported on Windows' };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

ipcMain.handle('get-configuration', async () => {
    return await getConfiguration();
});

// IPC handlers for renderer process
ipcMain.handle('get-printers', async () => {
  return await getPrinters();
});

// Simple printer test function for debugging
async function testPrinterConnection(printerName) {
  console.log('=== PRINTER TEST DEBUG ===');
  console.log('Testing printer:', printerName);
  console.log('Platform:', process.platform);
  
  // Test 1: Check if printer exists in system
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const checkCommand = `powershell -Command "Get-Printer -Name '${printerName}' | Select-Object Name,PrinterStatus"`;
      console.log('Checking if printer exists:', checkCommand);
      
      exec(checkCommand, (error, stdout, stderr) => {
        console.log('Printer check result:');
        console.log('Error:', error);
        console.log('Stdout:', stdout);
        console.log('Stderr:', stderr);
        
        if (error) {
          resolve({ 
            success: false, 
            error: `Printer "${printerName}" not found in system. Error: ${error.message}`,
            debug: { stdout, stderr, error: error.message }
          });
        } else {
          // Printer exists, now try simple print
          console.log('Printer found, attempting simple print...');
          resolve(attemptSimplePrint(printerName));
        }
      });
    } else {
      resolve(attemptSimplePrint(printerName));
    }
  });
}

// Attempt the simplest possible print
async function attemptSimplePrint(printerName) {
  let testContent = 'ProteusERP Test Print\n' + new Date().toString() + '\nPrinter: ' + printerName;
  
  console.log('=== TEST PRINT EXECUTION ===');
  console.log('Using printer:', printerName);
  console.log('Original test content length:', testContent.length);
  console.log('Original test content:', testContent);
  
  // Process content the same way as WebSocket print
  if (process.platform === 'win32') {
    // Ensure Windows line endings (CRLF)
    testContent = testContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    
    // Add form feed at the end to ensure page ejects
    if (!testContent.endsWith('\f')) {
      testContent += '\r\n\f';
    }
  }
  
  console.log('Processed test content length:', testContent.length);
  console.log('Processed test content:', testContent);
  
  // Use app.getPath('temp') for better cross-platform temp directory
  const { app } = require('electron');
  const tempDir = app.getPath('temp');
  const tempFile = path.join(tempDir, 'proteus_test_' + Date.now() + '.txt');
  
  try {
    // Write test content with explicit encoding
    fs.writeFileSync(tempFile, testContent, { encoding: 'utf8' });
    console.log('Test file created:', tempFile);
    
    // Verify file was written correctly
    const verifyContent = fs.readFileSync(tempFile, 'utf8');
    console.log('Verified test file content length:', verifyContent.length);
    console.log('Test file content matches:', verifyContent === testContent);
    
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        // Use PowerShell Out-Printer which properly targets the specific printer
        const escapedPrinter = printerName.replace(/'/g, "''");
        const escapedFile = tempFile.replace(/\\/g, '/');
        const psCommand = `powershell -Command "Get-Content '${escapedFile}' -Encoding UTF8 | Out-Printer -Name '${escapedPrinter}'"`;
        
        console.log('Test using PowerShell Out-Printer command:', psCommand);
        
        exec(psCommand, { timeout: 15000 }, (error, stdout, stderr) => {
          // Clean up temp file
          try {
            fs.unlinkSync(tempFile);
            console.log('Test temp file cleaned up');
          } catch (e) {
            console.warn('Could not delete test temp file:', e.message);
          }
          
          console.log('Test PowerShell Out-Printer result:');
          console.log('Error:', error);
          console.log('Stdout:', stdout);
          console.log('Stderr:', stderr);
          
          if (error) {
            resolve({ 
              success: false, 
              error: `PowerShell print failed: ${error.message}`,
              debug: { stdout, stderr, command: psCommand, printerName, tempFile }
            });
          } else {
            resolve({ 
              success: true, 
              data: { message: `Print job sent successfully to ${printerName} via PowerShell Out-Printer` }
            });
          }
        });
      } else {
        // Non-Windows platforms
        const printCommand = `lpr -P "${printerName}" "${tempFile}"`;
        exec(printCommand, (error, stdout, stderr) => {
          try {
            fs.unlinkSync(tempFile);
          } catch (e) {
            console.warn('Could not delete temp file:', e.message);
          }
          
          if (error) {
            resolve({ success: false, error: error.message });
          } else {
            resolve({ success: true, data: { message: 'Print sent successfully' } });
          }
        });
      }
    });
  } catch (fileError) {
    return { success: false, error: `Failed to create test file: ${fileError.message}` };
  }
}

ipcMain.handle('test-print', async (event, printer) => {
  console.log('=== TEST PRINT REQUEST ===');
  console.log('Printer requested:', printer);
  
  if (!printer) {
    console.log('No printer specified');
    return { success: false, error: 'No printer specified for test print' };
  }
  
  // Use the simple test function
  const result = await testPrinterConnection(printer);
  console.log('Final test result:', JSON.stringify(result, null, 2));
  return result;
});

ipcMain.handle('test-cash-drawer', async (event, printer) => {
  console.log('Cash drawer test request received for printer:', printer);
  
  if (!printer) {
    return { success: false, error: 'No printer specified for cash drawer test' };
  }
  
  console.log('Sending cash drawer command via handleCashDrawer function');
  const result = await handleCashDrawer({ 
    printer: printer,
    test: true 
  });
  
  console.log('Cash drawer test result:', result);
  return result;
});

ipcMain.handle('open-devtools', async (event) => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    focusedWindow.webContents.openDevTools();
  }
});

ipcMain.handle('save-config', async (event, config) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = getConfigPath(true);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('Configuration saved to', configPath);

    // Update transaction queue service with new API config
    if (transactionQueueService && (config.apiBaseUrl || config.apiKey)) {
      transactionQueueService.updateConfig({
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey
      });
    }

    // Update product cache service with new config including drawer ID
    if (productCacheService) {
      productCacheService.updateConfig({
        apiBaseUrl: config.apiBaseUrl,
        apiKey: config.apiKey,
        drawerId: config.selectedDrawerId || null
      });
      // Re-sync settings to get location-specific tax rates
      productCacheService.syncSettings().catch(err => console.error('Settings re-sync failed:', err));
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to save configuration:', error);
    return { success: false, error: error.message };
  }
});

// IPC handlers for tray interaction
ipcMain.handle('show-window', () => {
  showWindow();
});

ipcMain.handle('hide-window', () => {
  hideWindow();
});

// IPC handlers for scanner functionality
ipcMain.handle('get-scanners', async () => {
  try {
    return await scannerService.detectScanners();
  } catch (error) {
    console.error('Error getting scanners:', error);
    return { success: false, error: error.message, scanners: [] };
  }
});

ipcMain.handle('test-scan', async (event, scannerId, options = {}) => {
  console.log('Test scan request received for scanner:', scannerId);
  
  if (!scannerId) {
    return { success: false, error: 'No scanner specified for test scan' };
  }
  
  const testOptions = {
    resolution: 150, // Lower resolution for faster test
    colorMode: 'color',
    format: 'jpeg',
    quality: 80,
    ...options
  };
  
  console.log('Test scanning with options:', testOptions);
  const result = await scannerService.performScan(scannerId, testOptions);
  
  console.log('Test scan result:', result);
  return result;
});

ipcMain.handle('scan-and-upload', async (event, scannerId, options = {}, metadata = {}) => {
  console.log('Scan and upload request for scanner:', scannerId);
  
  if (!scannerId) {
    return { success: false, error: 'No scanner specified for scan and upload' };
  }
  
  // Get API configuration
  const config = await getConfiguration();
  if (!config.success || !config.data.apiBaseUrl) {
    return { success: false, error: 'API configuration not found. Please configure API settings first.' };
  }
  
  // Get API key from config file or storage  
  let apiKey = null;
  try {
    const configFilePath = getConfigPath();
    const configData = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    apiKey = configData.apiKey;
  } catch (error) {
    console.log('Could not read API key from config:', error.message);
  }
  
  if (!apiKey) {
    return { success: false, error: 'API key not found. Please configure API settings first in the application.' };
  }
  
  // Perform scan
  const scanResult = await scannerService.performScan(scannerId, options);
  if (!scanResult.success) {
    return scanResult;
  }
  
  // Upload to SaaS
  const uploadResult = await scannerService.uploadToSaaS(
    scanResult.data.filepath,
    config.data.apiBaseUrl,
    apiKey || config.data.apiKey,
    {
      ...metadata,
      scanner_id: scannerId,
      scan_settings: options
    }
  );
  
  if (uploadResult.success) {
    return {
      success: true,
      data: {
        scan: scanResult.data,
        upload: uploadResult.data,
        message: 'Document scanned and uploaded successfully'
      }
    };
  } else {
    return {
      success: false,
      error: `Scan completed but upload failed: ${uploadResult.error}`,
      data: {
        scan: scanResult.data,
        upload_error: uploadResult.error
      }
    };
  }
});

ipcMain.handle('get-scan-settings', async () => {
  return { success: true, data: scannerService.getScanSettings() };
});

ipcMain.handle('update-scan-settings', async (event, settings) => {
  try {
    scannerService.updateScanSettings(settings);
    return { success: true, data: scannerService.getScanSettings() };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC handlers for transaction queue
ipcMain.handle('get-queue-status', async () => {
  if (!transactionQueueService) {
    return { success: false, error: 'Queue service not initialized' };
  }
  return await transactionQueueService.getQueueStatus();
});

ipcMain.handle('retry-queue', async () => {
  if (!transactionQueueService) {
    return { success: false, error: 'Queue service not initialized' };
  }
  const result = await transactionQueueService.processQueue();
  return { success: true, ...result };
});

ipcMain.handle('get-queued-transactions', async (event, limit = 50) => {
  if (!transactionQueueService) {
    return { success: false, error: 'Queue service not initialized' };
  }
  return await transactionQueueService.getQueuedTransactions(limit);
});

ipcMain.handle('cancel-queued-transaction', async (event, transactionId) => {
  if (!transactionQueueService) {
    return { success: false, error: 'Queue service not initialized' };
  }
  return await transactionQueueService.cancelTransaction(transactionId);
});

// ==========================================
// EMERGENCY POS IPC HANDLERS
// ==========================================

// Open Emergency POS window
ipcMain.handle('open-emergency-pos', async () => {
  if (emergencyWindow) {
    emergencyWindow.focus();
    return { success: true, message: 'Emergency POS already open' };
  }

  emergencyWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'Emergency POS - Offline Mode',
    autoHideMenuBar: true
  });

  emergencyWindow.loadFile('emergency-pos.html');

  emergencyWindow.on('closed', () => {
    emergencyWindow = null;
  });

  return { success: true };
});

// Emergency POS: Get categories
ipcMain.handle('emergency-get-categories', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized', categories: [] };
  }
  try {
    const categories = await productCacheService.getCategories();
    return { success: true, categories };
  } catch (error) {
    return { success: false, error: error.message, categories: [] };
  }
});

// Emergency POS: Get settings (tax rates, etc.)
ipcMain.handle('emergency-get-settings', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized', taxRates: { combined: 0 } };
  }
  try {
    const settings = await productCacheService.getSettings();
    return { success: true, ...settings };
  } catch (error) {
    return { success: false, error: error.message, taxRates: { combined: 0 } };
  }
});

// Emergency POS: Force sync settings (with debug info)
ipcMain.handle('emergency-sync-settings', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized', debug: {} };
  }
  try {
    const drawerId = productCacheService.drawerId;
    const apiBaseUrl = productCacheService.apiBaseUrl;
    const apiKey = productCacheService.apiKey;

    // Build the URL that will be called
    let url = `${apiBaseUrl}/webservices/categories_json.cfm?webservicepass=${apiKey ? apiKey.substring(0, 5) + '...' : 'NOT SET'}&action=getSettings`;
    if (drawerId) {
      url += `&drawer=${drawerId}`;
    }

    // Force sync settings AND categories (to get updated addtax_rec values)
    const settingsSyncResult = await productCacheService.syncSettings();
    const categorySyncResult = await productCacheService.syncCategories();

    // Get the stored settings
    const settings = await productCacheService.getSettings();

    return {
      success: settingsSyncResult.success && categorySyncResult.success,
      error: settingsSyncResult.error || categorySyncResult.error,
      settings,
      debug: {
        drawerId,
        apiBaseUrl,
        apiKeySet: !!apiKey,
        urlCalled: url,
        settingsSyncResult,
        categorySyncResult
      }
    };
  } catch (error) {
    return { success: false, error: error.message, debug: { error: error.stack } };
  }
});

// Emergency POS: Get category tax info
ipcMain.handle('emergency-get-category-tax', async (event, categoryId) => {
  if (!productCacheService) {
    return { addtax: 0, mitsreportable: false };
  }
  try {
    return await productCacheService.getCategoryTaxInfo(categoryId);
  } catch (error) {
    console.error('Error getting category tax:', error);
    return { addtax: 0, mitsreportable: false };
  }
});

// Emergency POS: Search products
ipcMain.handle('emergency-search-products', async (event, query) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized', products: [] };
  }
  try {
    const products = await productCacheService.searchProducts(query);
    return { success: true, products };
  } catch (error) {
    return { success: false, error: error.message, products: [] };
  }
});

// Emergency POS: Get product by UPC
ipcMain.handle('emergency-get-product-by-upc', async (event, upc) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  try {
    const product = await productCacheService.getProductByUPC(upc);
    return { success: true, product };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Emergency POS: Get product by package ID (for barcode scanning)
ipcMain.handle('emergency-get-product-by-package', async (event, packageId) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  try {
    const product = await productCacheService.getProductByPackageId(packageId);
    return { success: true, product };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Sync packages from server
ipcMain.handle('sync-packages', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  try {
    const result = await productCacheService.syncPackages();
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get package count
ipcMain.handle('get-package-count', async () => {
  if (!productCacheService) {
    return { success: false, count: 0 };
  }
  try {
    const count = await productCacheService.getPackageCount();
    return { success: true, count };
  } catch (error) {
    return { success: false, count: 0, error: error.message };
  }
});

// Get packages for a specific product
ipcMain.handle('get-packages-for-product', async (event, productId) => {
  if (!productCacheService) {
    return { success: false, packages: [] };
  }
  try {
    const packages = await productCacheService.getPackagesForProduct(productId);
    return { success: true, packages };
  } catch (error) {
    return { success: false, packages: [], error: error.message };
  }
});

// Emergency POS: Get products by category
ipcMain.handle('emergency-get-products-by-category', async (event, category) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized', products: [] };
  }
  try {
    const products = await productCacheService.getProductsByCategory(category);
    return { success: true, products };
  } catch (error) {
    return { success: false, error: error.message, products: [] };
  }
});

// Emergency POS: Submit transaction (queues locally)
ipcMain.handle('emergency-submit-transaction', async (event, transaction) => {
  if (!transactionQueueService) {
    return { success: false, error: 'Transaction queue not initialized' };
  }
  try {
    // Generate idempotency key for offline transaction
    const idempotencyKey = `offline-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const result = await transactionQueueService.submitTransaction({
      idempotencyKey,
      type: 'sale',
      data: {
        ...transaction,
        offlineMode: true,
        source: 'emergency_pos'
      }
    });

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Emergency POS: Print receipt
ipcMain.handle('emergency-print-receipt', async (event, htmlContent) => {
  try {
    // Get configured printer
    const config = await getConfiguration();
    const printer = config.data?.selectedPrinter;

    if (!printer) {
      console.log('No printer configured, skipping receipt print');
      return { success: true, message: 'No printer configured' };
    }

    return await attemptWebSocketPrint(printer, htmlContent);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Emergency POS: Open cash drawer
ipcMain.handle('emergency-open-drawer', async () => {
  try {
    const config = await getConfiguration();
    const drawer = config.data?.selectedDrawer;

    if (!drawer) {
      console.log('No cash drawer configured');
      return { success: true, message: 'No drawer configured' };
    }

    return await handleCashDrawer({ printer: drawer });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Emergency POS: Get status
ipcMain.handle('emergency-get-status', async () => {
  try {
    const productCount = productCacheService ? await productCacheService.getProductCount() : 0;
    const queueStatus = transactionQueueService ? await transactionQueueService.getQueueStatus() : { data: { pending: 0 } };

    return {
      productCount,
      queuedCount: queueStatus.data?.pending || 0,
      lastSync: productCacheService?.lastSync || null
    };
  } catch (error) {
    return { productCount: 0, queuedCount: 0, lastSync: null };
  }
});

// Emergency POS: Search customers
ipcMain.handle('emergency-search-customers', async (event, query) => {
  try {
    if (!productCacheService || !productCacheService.apiBaseUrl || !productCacheService.apiKey) {
      return { success: false, error: 'API not configured', customers: [] };
    }

    const fetch = require('node-fetch');
    const url = `${productCacheService.apiBaseUrl}/webservices/customers/`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webservicepass: productCacheService.apiKey,
        action: 'search',
        q: query,
        maxrows: 20
      }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();

    if (result.error) {
      return { success: false, error: result.error, customers: [] };
    }

    // Result is an array of customers
    return { success: true, customers: Array.isArray(result) ? result : [] };
  } catch (error) {
    console.error('Customer search failed:', error);
    return { success: false, error: error.message, customers: [] };
  }
});

// Emergency POS: Get active staff list
ipcMain.handle('emergency-get-staff', async () => {
  try {
    if (!productCacheService || !productCacheService.apiBaseUrl || !productCacheService.apiKey) {
      return { success: false, error: 'API not configured', staff: [] };
    }

    const fetch = require('node-fetch');
    const url = `${productCacheService.apiBaseUrl}/webservices/staff/`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webservicepass: productCacheService.apiKey,
        action: 'getActiveStaff'
      }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();

    if (result.error) {
      return { success: false, error: result.error, staff: [] };
    }

    // Result is an array of staff members
    return { success: true, staff: Array.isArray(result) ? result : [] };
  } catch (error) {
    console.error('Staff fetch failed:', error);
    return { success: false, error: error.message, staff: [] };
  }
});

// Emergency POS: Verify staff PIN
ipcMain.handle('emergency-verify-staff-pin', async (event, staffId, pin) => {
  try {
    if (!productCacheService || !productCacheService.apiBaseUrl || !productCacheService.apiKey) {
      return { success: false, error: 'API not configured' };
    }

    const fetch = require('node-fetch');
    const url = `${productCacheService.apiBaseUrl}/webservices/staff/`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webservicepass: productCacheService.apiKey,
        action: 'verifyPin',
        staff_id: staffId,
        pin: pin || ''
      }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Staff PIN verification failed:', error);
    return { success: false, error: error.message };
  }
});

// Emergency POS: Get customer purchase limits
ipcMain.handle('emergency-get-purchase-limits', async (event, customerId, customerType, currentCartWeight) => {
  try {
    if (!productCacheService || !productCacheService.apiBaseUrl || !productCacheService.apiKey) {
      return { success: false, error: 'API not configured', hasLimits: false };
    }

    const fetch = require('node-fetch');
    const url = `${productCacheService.apiBaseUrl}/webservices/customers/`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webservicepass: productCacheService.apiKey,
        action: 'getPurchaseLimits',
        customerId: customerId || '',
        customerType: customerType || 'recreational',
        currentCartWeight: currentCartWeight || 0
      }),
      timeout: 10000
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Purchase limits fetch failed:', error);
    return { success: false, error: error.message, hasLimits: false };
  }
});

// Emergency POS: Exit
ipcMain.handle('emergency-exit', async () => {
  if (emergencyWindow) {
    emergencyWindow.close();
  }
  return { success: true };
});

// Product Cache: Manual sync
ipcMain.handle('sync-products', async (event, forceFullSync = false) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  // Also sync categories first
  await productCacheService.syncCategories();
  return await productCacheService.syncProducts(forceFullSync);
});

// Product Cache: Clear and resync
ipcMain.handle('clear-product-cache', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  return await productCacheService.clearCache();
});

// Product Cache: Get status
ipcMain.handle('get-product-cache-status', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  return { success: true, data: await productCacheService.getStatus() };
});

// Product Cache: Import products (for testing)
ipcMain.handle('import-products', async (event, products) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  return await productCacheService.importProducts(products);
});

// ==========================================
// Tax Settings IPC Handlers
// ==========================================

// Get current tax settings
ipcMain.handle('get-tax-settings', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized', settings: null };
  }
  try {
    const settings = await productCacheService.getSettings();
    return { success: true, settings };
  } catch (error) {
    console.error('Error getting tax settings:', error);
    return { success: false, error: error.message, settings: null };
  }
});

// Save tax settings locally (for offline mode configuration)
ipcMain.handle('save-tax-settings', async (event, taxSettings) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  try {
    const result = await productCacheService.saveTaxSettings(taxSettings);
    return result;
  } catch (error) {
    console.error('Error saving tax settings:', error);
    return { success: false, error: error.message };
  }
});

// Sync tax settings from API
ipcMain.handle('sync-tax-settings', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  try {
    const result = await productCacheService.syncSettings();
    if (result.success) {
      const settings = await productCacheService.getSettings();
      return { success: true, settings };
    }
    return result;
  } catch (error) {
    console.error('Error syncing tax settings:', error);
    return { success: false, error: error.message };
  }
});

// Calculate tax for a transaction
ipcMain.handle('calculate-tax', async (event, subtotal, customerType, categoryInfo) => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized', tax: 0 };
  }
  try {
    const result = await productCacheService.calculateTax(subtotal, customerType, categoryInfo);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error calculating tax:', error);
    return { success: false, error: error.message, totalTax: 0, total: subtotal };
  }
});

// Get default tax settings structure
ipcMain.handle('get-default-tax-settings', async () => {
  if (!productCacheService) {
    return { success: false, error: 'Product cache not initialized' };
  }
  return { success: true, settings: productCacheService.getDefaultTaxSettings() };
});

// ===================
// Auto-Updater IPC
// ===================
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('check-for-updates', () => {
  autoUpdater.checkForUpdatesAndNotify();
});

// App event handlers
app.whenReady().then(() => {
    createWindow();
    createTray();
    initializeWebSocketServer();

    // Auto-updater setup
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      console.log('Update available:', info.version);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-available', { version: info.version });
      }
    });

    autoUpdater.on('download-progress', (progress) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('download-progress', { percent: Math.round(progress.percent) });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('Update downloaded:', info.version);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-downloaded', { version: info.version });
      }
    });

    autoUpdater.on('error', (err) => {
      console.log('Auto-updater error:', err.message);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-error', { message: err.message });
      }
    });

    // Check for updates after a short delay to let the app fully initialize
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify();
    }, 5000);
    
    // Initialize scanner service
    scannerService = new ScannerService();
    console.log('Scanner service initialized');

    // Initialize transaction queue service
    transactionQueueService = new TransactionQueueService();

    // Load config and initialize queue service
    const configPath = getConfigPath();
    let queueConfig = {};
    try {
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        queueConfig = {
          apiBaseUrl: configData.apiBaseUrl,
          apiKey: configData.apiKey,
          drawerId: configData.selectedDrawerId || null
        };
      }
    } catch (error) {
      console.log('Could not load config for queue service:', error.message);
    }

    transactionQueueService.initialize(app.getPath('userData'), queueConfig);

    // Initialize product cache service
    productCacheService = new ProductCacheService();
    productCacheService.initialize(app.getPath('userData'), queueConfig);
    console.log('Product cache service initialized');

    // Forward queue events to renderer
    transactionQueueService.on('transactionQueued', (data) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('queue-status-update', { event: 'queued', ...data });
      }
    });

    transactionQueueService.on('transactionSynced', (data) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('queue-status-update', { event: 'synced', ...data });
      }
    });

    transactionQueueService.on('online', () => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('queue-status-update', { event: 'online' });
      }
      // Notify product cache service to trigger sync
      if (productCacheService) {
        productCacheService.setOnlineStatus(true);
      }
    });

    transactionQueueService.on('offline', (data) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('queue-status-update', { event: 'offline', reason: data?.reason });
      }
      // Notify product cache service
      if (productCacheService) {
        productCacheService.setOnlineStatus(false);
      }
    });

    console.log('Transaction queue service initialized');

    // Forward product cache sync events to renderer
    productCacheService.on('syncStarted', () => {
      console.log('Product sync started');
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('sync-status-update', { event: 'started' });
      }
    });

    productCacheService.on('syncCompleted', (data) => {
      console.log('Product sync completed:', data);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('sync-status-update', { event: 'completed', ...data });
      }
    });

    productCacheService.on('syncComplete', (data) => {
      console.log('Full sync complete:', data);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('sync-status-update', { event: 'completed', ...data });
      }
    });

    productCacheService.on('syncFailed', (error) => {
      console.log('Sync failed:', error.message);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('sync-status-update', { event: 'failed', error: error.message });
      }
    });

    productCacheService.on('syncError', (error) => {
      console.log('Sync error:', error.message);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('sync-status-update', { event: 'failed', error: error.message });
      }
    });

    // Set up auto-start on Windows login
    if (process.platform === 'win32') {
      // Enable auto-start with hidden flag
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true, // Start minimized/hidden
        path: process.execPath,
        args: ['--hidden'] // Pass argument to know it auto-started
      });
      
      console.log('Auto-start on Windows login enabled (hidden mode)');
    }
    
    app.on('activate', () => {
      // On macOS, show window when dock icon is clicked
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        showWindow();
      }
    });
  });

app.on('window-all-closed', () => {
  // Don't quit the app when all windows are closed - keep running in tray
  // The user can quit from the tray context menu
  console.log('All windows closed, continuing to run in system tray');
});

app.on('before-quit', () => {
  app.isQuiting = true;

  // Clean up tray
  if (tray) {
    tray.destroy();
  }

  // Close WebSocket server
  if (wsServer) {
    wsServer.close();
  }

  // Shutdown transaction queue service
  if (transactionQueueService) {
    transactionQueueService.shutdown();
  }

  // Shutdown product cache service
  if (productCacheService) {
    productCacheService.shutdown();
  }

  // Close emergency window if open
  if (emergencyWindow) {
    emergencyWindow.close();
  }
});

// Handle certificate errors for development
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

