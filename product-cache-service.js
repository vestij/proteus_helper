const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class ProductCacheService extends EventEmitter {
    constructor() {
        super();
        this.db = null;
        this.categoryDb = null;
        this.packageDb = null;
        this.userDataPath = null;
        this.syncTimer = null;
        this.apiBaseUrl = null;
        this.apiKey = null;
        this.drawerId = null;
        this.lastSync = null;
        this.lastPackageSync = null;
        this.syncInterval = 60 * 60 * 1000; // 1 hour
        this.isSyncing = false;
        this.isOnline = true;  // Assume online initially
    }

    /**
     * Set online status (called from main process)
     */
    setOnlineStatus(online) {
        const wasOffline = !this.isOnline;
        this.isOnline = online;

        // If we just came back online, trigger a sync
        if (wasOffline && online && this.apiBaseUrl && this.apiKey) {
            console.log('Back online - triggering sync');
            this.performSync();
        }
    }

    /**
     * Initialize the product cache database
     */
    async initialize(userDataPath, config = {}) {
        console.log('=== INITIALIZING PRODUCT CACHE SERVICE ===');

        // Store userDataPath for later use (e.g., clearing cache)
        this.userDataPath = userDataPath;

        // Set up database paths
        const productDbPath = path.join(userDataPath, 'product-cache.db');
        const categoryDbPath = path.join(userDataPath, 'category-cache.db');
        const packageDbPath = path.join(userDataPath, 'package-cache.db');
        console.log('Product cache path:', productDbPath);
        console.log('Package cache path:', packageDbPath);

        // Initialize NeDB for products
        this.db = Datastore.create({
            filename: productDbPath,
            autoload: true
        });

        // Initialize NeDB for categories
        this.categoryDb = Datastore.create({
            filename: categoryDbPath,
            autoload: true
        });

        // Initialize NeDB for packages (barcode -> product mappings)
        this.packageDb = Datastore.create({
            filename: packageDbPath,
            autoload: true
        });

        // Create indexes
        await this.db.ensureIndex({ fieldName: 'id', unique: true });
        await this.db.ensureIndex({ fieldName: 'upc' });
        await this.db.ensureIndex({ fieldName: 'sku' });
        await this.db.ensureIndex({ fieldName: 'name' });
        await this.db.ensureIndex({ fieldName: 'category' });
        await this.categoryDb.ensureIndex({ fieldName: 'id', unique: true });
        await this.packageDb.ensureIndex({ fieldName: 'internalId', unique: true });
        await this.packageDb.ensureIndex({ fieldName: 'packageId' }); // barcode - not unique, multiple packages can share same barcode
        await this.packageDb.ensureIndex({ fieldName: 'productId' });

        // Load config
        this.apiBaseUrl = config.apiBaseUrl;
        this.apiKey = config.apiKey;
        this.drawerId = config.drawerId || null;

        // Load last sync times
        try {
            const meta = await this.db.findOne({ _type: 'meta' });
            if (meta) {
                this.lastSync = meta.lastSync ? new Date(meta.lastSync) : null;
                this.lastPackageSync = meta.lastPackageSync ? new Date(meta.lastPackageSync) : null;
            }
        } catch (e) {
            this.lastSync = null;
            this.lastPackageSync = null;
        }

        console.log('Product cache initialized. Last sync:', this.lastSync, 'Last package sync:', this.lastPackageSync);

        // Start auto-sync if configured
        if (this.apiBaseUrl && this.apiKey) {
            this.startAutoSync();
        }

        return { success: true };
    }

    /**
     * Update API configuration
     */
    updateConfig(config) {
        if (config.apiBaseUrl) this.apiBaseUrl = config.apiBaseUrl;
        if (config.apiKey) this.apiKey = config.apiKey;
        if (config.drawerId !== undefined) this.drawerId = config.drawerId;

        // Restart auto-sync with new config
        if (this.apiBaseUrl && this.apiKey) {
            this.startAutoSync();
        }
    }

    /**
     * Start automatic background sync
     */
    startAutoSync() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
        }

        // Always sync settings on startup (small payload, critical for tax rates)
        if (this.isOnline) {
            this.syncSettings().catch(err => console.error('Settings sync failed:', err));
        }

        // Sync categories, products, and packages if we haven't synced recently
        const timeSinceSync = this.lastSync ? Date.now() - this.lastSync.getTime() : Infinity;
        if (timeSinceSync > this.syncInterval && this.isOnline) {
            this.performSync();
        }

        // Schedule periodic sync
        this.syncTimer = setInterval(() => {
            if (this.isOnline) {
                this.performSync();
            } else {
                console.log('Skipping auto-sync - offline');
            }
        }, this.syncInterval);

        console.log('Auto-sync started, interval:', this.syncInterval / 60000, 'minutes');
    }

    /**
     * Perform a full incremental sync of all data
     */
    async performSync() {
        console.log('=== PERFORMING INCREMENTAL SYNC ===');
        console.log('Last product sync:', this.lastSync);
        console.log('Last package sync:', this.lastPackageSync);

        try {
            // Sync in sequence to avoid overwhelming the API
            await this.syncSettings();
            await this.syncCategories();
            const productResult = await this.syncProducts();
            const packageResult = await this.syncPackages();

            console.log('Sync complete:', {
                products: productResult.success ? `${productResult.updated || 0} updated, ${productResult.inserted || 0} inserted` : productResult.error,
                packages: packageResult.success ? `${packageResult.updated || 0} updated, ${packageResult.inserted || 0} inserted` : packageResult.error
            });

            this.emit('syncComplete', { products: productResult, packages: packageResult });
            return { success: true, products: productResult, packages: packageResult };
        } catch (error) {
            console.error('Sync failed:', error.message);
            this.emit('syncError', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Sync location settings (tax rates, etc.) from server
     */
    async syncSettings() {
        if (!this.apiBaseUrl || !this.apiKey) {
            console.log('API not configured, cannot sync settings');
            return { success: false, error: 'API not configured' };
        }

        console.log('=== SYNCING SETTINGS ===');
        console.log('Drawer ID:', this.drawerId);

        try {
            const fetch = require('node-fetch');

            // Include drawer ID if configured to get location-specific tax rates
            let url = `${this.apiBaseUrl}/webservices/categories_json.cfm?webservicepass=${encodeURIComponent(this.apiKey)}&action=getSettings`;
            if (this.drawerId) {
                url += `&drawer=${encodeURIComponent(this.drawerId)}`;
            }

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const responseText = await response.text();
            let apiSettings;

            try {
                apiSettings = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Failed to parse settings response:', responseText.substring(0, 500));
                throw new Error('Invalid JSON response from settings API');
            }

            if (apiSettings.error) {
                throw new Error(apiSettings.error);
            }

            // Parse and normalize the tax settings from API
            const normalizedSettings = this.normalizeTaxSettings(apiSettings);

            // Get existing local settings to preserve local-only fields
            const existingSettings = await this.categoryDb.findOne({ _type: 'settings' });

            // Preserve local rounding settings if API doesn't provide them
            let roundingSettings = normalizedSettings.rounding;
            if ((!roundingSettings || !roundingSettings.direction || !roundingSettings.amount) && existingSettings?.rounding) {
                roundingSettings = existingSettings.rounding;
                console.log('Preserving local rounding settings:', roundingSettings);
            }

            // Store settings in the category database
            await this.categoryDb.update(
                { _type: 'settings' },
                {
                    _type: 'settings',
                    ...normalizedSettings,
                    // Preserve local rounding if API doesn't have it
                    rounding: roundingSettings,
                    // Keep legacy taxRates for backward compatibility
                    taxRates: apiSettings.taxRates || normalizedSettings.taxRates,
                    // Store taxRules as taxFlags for backward compatibility with emergency POS
                    taxFlags: normalizedSettings.taxRules || {},
                    location: apiSettings.location,
                    lastUpdated: new Date().toISOString()
                },
                { upsert: true }
            );

            console.log('Settings synced:', JSON.stringify(normalizedSettings, null, 2));
            return { success: true, settings: normalizedSettings };

        } catch (error) {
            console.error('Settings sync failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Normalize tax settings from API response to our local format
     * Maps the ColdFusion field names to our structure
     */
    normalizeTaxSettings(apiSettings) {
        const defaults = this.getDefaultTaxSettings();

        // Determine if this is a 420 business (API now returns this directly)
        const is420 = apiSettings.is420 === true ||
                      apiSettings.proteusType?.includes('420') ||
                      apiSettings.businessType === '420';

        // Parse tax rates - API returns as decimals (e.g., 0.0825 for 8.25%)
        const parseRate = (val) => {
            if (val === null || val === undefined || val === '') return 0;
            const num = parseFloat(val);
            return isNaN(num) ? 0 : num;
        };

        // Parse boolean/int flags (API returns 0/1)
        const parseBool = (val) => val === 1 || val === true || val === '1';

        // API now returns structured objects, use them directly if available
        const taxRates = apiSettings.taxRates || {};
        const medicalTaxRates = apiSettings.medicalTaxRates || {};
        const recTaxRates = apiSettings.recTaxRates || {};
        const includedTaxRates = apiSettings.includedTaxRates || {};
        const taxRules = apiSettings.taxRules || {};

        return {
            is420,
            proteusType: apiSettings.proteusType || '',

            // Legacy format for backward compatibility
            taxRates: {
                state: parseRate(taxRates.state),
                city: parseRate(taxRates.city),
                excise: parseRate(taxRates.excise),
                combined: parseRate(taxRates.combined)
            },

            // Medical tax rates (420 only)
            medicalTaxRates: {
                state: parseRate(medicalTaxRates.state),
                city: parseRate(medicalTaxRates.city),
                excise: parseRate(medicalTaxRates.excise)
            },

            // Recreational tax rates (420 only)
            recTaxRates: {
                state: parseRate(recTaxRates.state),
                city: parseRate(recTaxRates.city),
                excise: parseRate(recTaxRates.excise)
            },

            // Included tax rates (taxes already in price)
            includedTaxRates: {
                state: parseRate(includedTaxRates.state),
                stateMed: parseRate(includedTaxRates.stateMed),
                city: parseRate(includedTaxRates.city),
                cityMed: parseRate(includedTaxRates.cityMed),
                excise: parseRate(includedTaxRates.excise),
                exciseMed: parseRate(includedTaxRates.exciseMed)
            },

            // PO Excise tax rate
            poExciseTax: parseRate(apiSettings.poExciseTax),

            // Tax calculation rules (API now returns camelCase keys)
            taxRules: {
                taxesIncludedOrNot: parseInt(taxRules.taxesIncludedOrNot) || 0,
                cityOnCost: parseBool(taxRules.cityOnCost),
                cityTaxStateTaxable: parseBool(taxRules.cityTaxStateTaxable),
                stateOnCost: parseBool(taxRules.stateOnCost),
                exciseTaxPreTax: parseBool(taxRules.exciseTaxPreTax),
                exciseTaxStatePreTax: parseBool(taxRules.exciseTaxStatePreTax),
                exciseTaxStateCatPreTax: parseBool(taxRules.exciseTaxStateCatPreTax),
                exciseTaxCatInTax: parseBool(taxRules.exciseTaxCatInTax),
                exciseTaxOnCost: parseBool(taxRules.exciseTaxOnCost),
                exciseTaxOnRetail: parseBool(taxRules.exciseTaxOnRetail),
                exciseFromPO: parseBool(taxRules.exciseFromPO),
                includeFeesInCalculation: parseBool(taxRules.includeFeesInCalculation),
                cannabisExciseOnly: parseBool(taxRules.cannabisExciseOnly)
            },

            // Location info
            location: apiSettings.location || null,

            // Default customer type
            defaultCustomerType: apiSettings.defaultCustomerType || 'recreational',

            // Rounding settings
            rounding: {
                direction: apiSettings.rounding?.direction || '',  // 'up', 'down', 'nearest', or '' for none
                amount: parseFloat(apiSettings.rounding?.amount) || 0  // e.g., 0.05, 0.25, 1.00
            }
        };
    }

    /**
     * Get stored settings
     */
    async getSettings() {
        const settings = await this.categoryDb.findOne({ _type: 'settings' });
        return settings || this.getDefaultTaxSettings();
    }

    /**
     * Get default tax settings structure
     */
    getDefaultTaxSettings() {
        return {
            // Business type
            is420: false,

            // Tax rates (legacy format for backward compatibility)
            taxRates: {
                state: 0,
                city: 0,
                excise: 0,
                combined: 0
            },

            // 420 Business: Medical tax rates (percentages stored as decimals, e.g., 0.0825 = 8.25%)
            medicalTaxRates: {
                state: 0,           // taxrate
                city: 0,            // taxrate_city
                excise: 0           // excise_tax
            },

            // 420 Business: Recreational tax rates
            recTaxRates: {
                state: 0,           // retail_state_salestax
                city: 0,            // retail_city_salestax
                excise: 0           // retail_excise_tax
            },

            // Included tax rates (taxes already in price) - for reporting only
            includedTaxRates: {
                state: 0,           // reportonly_statetaxrate
                stateMed: 0,        // reportonly_statetaxrate_med
                city: 0,            // reportonly_citytaxrate
                cityMed: 0,         // reportonly_citytaxrate_med
                excise: 0,          // reportonly_excisetaxrate
                exciseMed: 0        // reportonly_excisetaxrate_med
            },

            // PO Excise tax rate
            poExciseTax: 0,         // po_excise_tax

            // Tax calculation rules/flags
            taxRules: {
                // Tax inclusion mode: 0=not included, 1=already included in price, 2=both
                taxesIncludedOrNot: 0,

                // City tax rules
                cityOnCost: false,              // calculated on cost instead of price
                cityTaxStateTaxable: false,     // include city tax in state tax calculation

                // State tax rules
                stateOnCost: false,             // calculated on cost instead of price

                // Excise tax rules
                exciseTaxPreTax: false,         // include in state/city tax
                exciseTaxStatePreTax: false,    // include in state (not city) tax
                exciseTaxStateCatPreTax: false, // include city tax in excise calculation
                exciseTaxCatInTax: false,       // include category tax in excise calculation
                exciseTaxOnCost: false,         // calculate on item cost
                exciseTaxOnRetail: false,       // calculate on item retail (pre-discount)
                exciseFromPO: false,            // calculate from PO excise
                includeFeesInCalculation: false,// include fees in calculation
                cannabisExciseOnly: false       // no state/city taxes on cannabis categories
            },

            // Location info
            location: null,
            defaultCustomerType: 'recreational',

            // Rounding settings
            rounding: {
                direction: '',  // 'up', 'down', 'nearest', or '' for none
                amount: 0       // e.g., 0.05, 0.25, 1.00
            },

            // Metadata
            lastUpdated: null
        };
    }

    /**
     * Save tax settings locally (for manual configuration in offline mode)
     */
    async saveTaxSettings(taxSettings) {
        const currentSettings = await this.getSettings();

        const updatedSettings = {
            ...currentSettings,
            ...taxSettings,
            _type: 'settings',
            lastUpdated: new Date().toISOString()
        };

        await this.categoryDb.update(
            { _type: 'settings' },
            updatedSettings,
            { upsert: true }
        );

        console.log('Tax settings saved locally:', updatedSettings);
        return { success: true, settings: updatedSettings };
    }

    /**
     * Calculate tax for a transaction
     * @param {number} subtotal - Pre-tax subtotal
     * @param {string} customerType - 'medical' or 'recreational'
     * @param {Object} categoryInfo - Category tax info (addtax, mitsreportable)
     */
    async calculateTax(subtotal, customerType = 'recreational', categoryInfo = {}) {
        const settings = await this.getSettings();
        const isMedical = customerType === 'medical' || customerType === 'patient';

        let stateTax = 0;
        let cityTax = 0;
        let exciseTax = 0;
        let categoryTax = 0;

        // Get base rates based on customer type
        const rates = isMedical ? settings.medicalTaxRates : settings.recTaxRates;

        // Check if taxes are included in price
        const taxesIncluded = settings.taxRules?.taxesIncludedOrNot === 1;

        if (!taxesIncluded) {
            // Calculate excise tax first if it needs to be included in other calculations
            if (settings.is420 && categoryInfo.mitsreportable) {
                const exciseBase = settings.taxRules?.exciseTaxOnCost
                    ? (categoryInfo.cost || 0)
                    : subtotal;
                exciseTax = exciseBase * (rates.excise || 0);
            }

            // Calculate state tax
            let stateBase = subtotal;
            if (settings.taxRules?.exciseTaxPreTax || settings.taxRules?.exciseTaxStatePreTax) {
                stateBase += exciseTax;
            }
            stateTax = stateBase * (rates.state || 0);

            // Calculate city tax
            let cityBase = settings.taxRules?.cityOnCost ? (categoryInfo.cost || 0) : subtotal;
            if (settings.taxRules?.exciseTaxPreTax && !settings.taxRules?.exciseTaxStatePreTax) {
                cityBase += exciseTax;
            }
            cityTax = cityBase * (rates.city || 0);

            // Add category tax if applicable
            if (categoryInfo.addtax) {
                categoryTax = subtotal * categoryInfo.addtax;
            }
        }

        const totalTax = stateTax + cityTax + exciseTax + categoryTax;

        return {
            subtotal,
            stateTax: Math.round(stateTax * 100) / 100,
            cityTax: Math.round(cityTax * 100) / 100,
            exciseTax: Math.round(exciseTax * 100) / 100,
            categoryTax: Math.round(categoryTax * 100) / 100,
            totalTax: Math.round(totalTax * 100) / 100,
            total: Math.round((subtotal + totalTax) * 100) / 100,
            taxesIncluded,
            customerType
        };
    }

    /**
     * Sync categories from server
     * Uses /webservices/categories_json.cfm endpoint
     */
    async syncCategories() {
        if (!this.apiBaseUrl || !this.apiKey) {
            console.log('API not configured, cannot sync categories');
            return { success: false, error: 'API not configured' };
        }

        // Also sync settings when syncing categories
        await this.syncSettings();

        console.log('=== SYNCING CATEGORIES ===');

        try {
            const fetch = require('node-fetch');

            // Categories endpoint uses query params
            const url = `${this.apiBaseUrl}/webservices/categories_json.cfm?webservicepass=${encodeURIComponent(this.apiKey)}&action=listcategories`;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const responseText = await response.text();
            let categories;

            try {
                categories = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Failed to parse categories response:', responseText.substring(0, 500));
                throw new Error('Invalid JSON response from categories API');
            }

            if (categories.error) {
                throw new Error(categories.error);
            }

            if (!Array.isArray(categories)) {
                console.log('Categories response is not an array');
                return { success: false, error: 'Invalid categories format' };
            }

            console.log(`Received ${categories.length} categories`);

            // Clear existing categories and insert fresh
            await this.categoryDb.remove({}, { multi: true });

            let inserted = 0;
            for (const cat of categories) {
                // Decode URL-encoded name
                const name = decodeURIComponent(cat.name || '');

                // Log debug info if present
                if (cat.addtax_debug) {
                    console.log(`Category "${name}" addtax debug:`, cat.addtax_debug);
                }

                // Insert parent category (no parentId means it's a top-level category)
                await this.categoryDb.insert({
                    id: String(cat.id),
                    name: name,
                    isParent: true,
                    addtax: parseFloat(cat.addtax) || 0,  // Category-specific tax rate
                    mitsreportable: cat.mitsreportable === 1,  // Cannabis/excise taxable
                    subcategories: (cat.subcategories || []).map(sub => {
                        // Log subcategory debug info if present
                        if (sub.addtax_debug) {
                            console.log(`  Subcategory "${decodeURIComponent(sub.name || '')}" addtax debug:`, sub.addtax_debug);
                        }
                        return {
                            id: String(sub.id),
                            name: decodeURIComponent(sub.name || ''),
                            addtax: parseFloat(sub.addtax) || 0,
                            mitsreportable: sub.mitsreportable === 1
                        };
                    })
                });
                inserted++;
            }

            console.log(`Categories sync complete. Inserted: ${inserted}`);
            return { success: true, inserted };

        } catch (error) {
            console.error('Category sync failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Sync package ID to product mappings from server
     * Uses the existing /webservices/items/packages/ endpoint
     * Packages are used for barcode scanning where the barcode contains a package ID
     */
    async syncPackages() {
        if (!this.apiBaseUrl || !this.apiKey) {
            console.log('API not configured, cannot sync packages');
            return { success: false, error: 'API not configured' };
        }

        console.log('=== SYNCING PACKAGES ===');

        try {
            const fetch = require('node-fetch');

            // Use existing packages API endpoint (POST-based)
            const url = `${this.apiBaseUrl}/webservices/items/packages/`;

            const requestBody = {
                webservicepass: this.apiKey,
                instock: 1  // Only get packages with quantity > 0 and active products
            };

            // For incremental sync, add dt_updated filter
            if (this.lastPackageSync) {
                requestBody.dt_updated = this.lastPackageSync.toISOString();
                console.log('Incremental package sync since:', requestBody.dt_updated);
            } else {
                console.log('Full package sync (no previous sync)');
            }

            console.log('Request URL:', url);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                timeout: 120000 // 2 minutes for potentially large package lists
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const responseText = await response.text();
            let result;

            try {
                result = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Failed to parse packages response:', responseText.substring(0, 500));
                throw new Error('Invalid JSON response from packages API');
            }

            if (result.error) {
                throw new Error(result.error);
            }

            // Handle ColdFusion COLUMNS/DATA format or direct array
            let packages = [];
            if (result.DATA && result.COLUMNS) {
                packages = this.convertColumnsData(result.COLUMNS, result.DATA);
            } else if (Array.isArray(result)) {
                packages = result;
            } else if (result.DATA && Array.isArray(result.DATA)) {
                packages = result.DATA;
            }

            console.log(`Received ${packages.length} packages`);

            if (packages.length === 0) {
                console.log('No packages returned from API');
                this.lastPackageSync = new Date();
                await this.saveLastPackageSync();
                return { success: true, inserted: 0, updated: 0 };
            }

            // Only clear on full sync (no lastPackageSync)
            if (!this.lastPackageSync) {
                await this.packageDb.remove({}, { multi: true });
                console.log('Cleared existing packages for full sync');
            }

            let inserted = 0;
            for (const pkg of packages) {
                // API returns: id (package_id), packageid (barcode), product_id, SKU, UPC, artist_name, price, etc.
                const barcode = pkg.packageid || pkg.PACKAGEID || pkg.barcode || pkg.BARCODE;
                const productId = pkg.product_id || pkg.PRODUCT_ID;
                const internalId = pkg.id || pkg.ID;

                if (!barcode || !internalId) continue;

                const packageData = {
                    packageId: String(barcode),
                    internalId: String(internalId),
                    productId: productId ? String(productId) : null,
                    sku: pkg.SKU || pkg.sku || '',
                    upc: pkg.UPC || pkg.upc || '',
                    productName: pkg.artist_name || pkg.ARTIST_NAME || '',
                    price: parseFloat(pkg.price || pkg.PRICE) || 0,
                    salePrice: parseFloat(pkg.sale_price || pkg.SALE_PRICE) || 0,
                    quantity: parseFloat(pkg.quantity || pkg.QUANTITY) || 0,
                    thcPercent: pkg.thcpercent || pkg.THCPERCENT || '',
                    cbdPercent: pkg.cbdpercent || pkg.CBDPERCENT || '',
                    lastUpdated: new Date().toISOString()
                };

                // Use upsert to handle duplicates gracefully
                await this.packageDb.update(
                    { internalId: String(internalId) },
                    packageData,
                    { upsert: true }
                );
                inserted++;
            }

            this.lastPackageSync = new Date();
            await this.saveLastPackageSync();
            console.log(`Package sync complete. Inserted: ${inserted}`);
            return { success: true, inserted };

        } catch (error) {
            console.error('Package sync failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Save lastPackageSync to the meta document
     */
    async saveLastPackageSync() {
        try {
            const meta = await this.db.findOne({ _type: 'meta' }) || { _type: 'meta' };
            meta.lastPackageSync = this.lastPackageSync.toISOString();
            await this.db.update(
                { _type: 'meta' },
                meta,
                { upsert: true }
            );
        } catch (e) {
            console.error('Failed to save lastPackageSync:', e.message);
        }
    }

    /**
     * Get product by package ID (for barcode scanning)
     * Returns the full product info by looking up the package mapping
     */
    async getProductByPackageId(packageId) {
        if (!packageId) return null;

        const pkgId = String(packageId).trim();
        console.log('Looking up package:', pkgId);

        // First find the package mapping
        const packageMapping = await this.packageDb.findOne({ packageId: pkgId });

        if (packageMapping) {
            console.log('Found package mapping:', packageMapping);

            // Try to get full product details by product ID first
            if (packageMapping.productId) {
                const product = await this.getProductById(packageMapping.productId);
                if (product) {
                    // Return product with package info attached
                    return {
                        ...product,
                        _packageId: pkgId,
                        _packageMapping: packageMapping
                    };
                }
            }

            // Try to find by UPC if we have it
            if (packageMapping.upc) {
                const product = await this.getProductByUPC(packageMapping.upc);
                if (product) {
                    return {
                        ...product,
                        _packageId: pkgId,
                        _packageMapping: packageMapping
                    };
                }
            }

            // Try to find by SKU if we have it
            if (packageMapping.sku) {
                const product = await this.db.findOne({
                    sku: packageMapping.sku,
                    _type: { $exists: false }
                });
                if (product) {
                    return {
                        ...product,
                        _packageId: pkgId,
                        _packageMapping: packageMapping
                    };
                }
            }

            // If product not in cache, return basic info from package mapping
            const price = packageMapping.salePrice > 0 && packageMapping.salePrice < packageMapping.price
                ? packageMapping.salePrice
                : packageMapping.price;

            return {
                id: packageMapping.productId || packageMapping.internalId,
                sku: packageMapping.sku,
                upc: packageMapping.upc,
                name: packageMapping.productName || `Package: ${pkgId}`,
                price: price || 0,
                regularPrice: packageMapping.price || 0,
                salePrice: packageMapping.salePrice || 0,
                _packageId: pkgId,
                _packageMapping: packageMapping,
                _fromPackageOnly: true
            };
        }

        console.log('Package not found:', pkgId);
        return null;
    }

    /**
     * Get package count
     */
    async getPackageCount() {
        return await this.packageDb.count({});
    }

    /**
     * Get all packages for a specific product
     * Used for showing available packages in the POS
     * Returns packages sorted by internalId (oldest first) for FIFO
     */
    async getPackagesForProduct(productId) {
        if (!productId) return [];

        const prodId = String(productId);
        console.log('Getting packages for product:', prodId);

        // Sort by internalId ascending (oldest packages first for FIFO)
        const packages = await this.packageDb.find({ productId: prodId }).sort({ internalId: 1 });
        console.log(`Found ${packages.length} packages for product ${prodId}`);

        return packages.map(pkg => ({
            packageId: pkg.packageId,
            internalId: pkg.internalId,
            quantity: pkg.quantity,
            thcPercent: pkg.thcPercent,
            cbdPercent: pkg.cbdPercent
        }));
    }

    /**
     * Sync products from server
     * Uses the Proteus /webservices/items/ endpoint
     */
    async syncProducts(forceFullSync = false) {
        if (this.isSyncing) {
            console.log('Sync already in progress, skipping');
            return { success: false, error: 'Sync in progress' };
        }

        if (!this.apiBaseUrl || !this.apiKey) {
            console.log('API not configured, cannot sync');
            return { success: false, error: 'API not configured' };
        }

        this.isSyncing = true;
        this.emit('syncStarted');
        console.log('=== SYNCING PRODUCTS ===');
        console.log('API Base URL:', this.apiBaseUrl);
        console.log('API Key (first 5 chars):', this.apiKey ? this.apiKey.substring(0, 5) + '...' : 'NOT SET');
        console.log('Force full sync:', forceFullSync);

        try {
            const fetch = require('node-fetch');

            // Proteus items API is POST-based
            const url = `${this.apiBaseUrl}/webservices/items/`;
            console.log('Request URL:', url);

            // Build request body - use dt_updated for incremental sync
            const requestBody = {
                action: 'get',
                webservicepass: this.apiKey,
                active: 1,
                instock: 1,  // Only get products that are in stock (follows showproductsfunc rules)
                include_all_categories: true
            };

            // For incremental sync, add dt_updated (unless forcing full sync)
            if (this.lastSync && !forceFullSync) {
                requestBody.dt_updated = this.lastSync.toISOString();
            } else {
                // First sync or forced - get all active products by using a very old date
                requestBody.dt_updated = '2000-01-01';
            }

            console.log('Request body:', JSON.stringify(requestBody, null, 2));

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                timeout: 120000 // 2 minutes for large catalogs
            });

            console.log('Response status:', response.status, response.statusText);

            if (!response.ok) {
                throw new Error(`API error: ${response.status} ${response.statusText}`);
            }

            const responseText = await response.text();
            console.log('Response length:', responseText.length);
            console.log('Response preview:', responseText.substring(0, 500));

            let result;

            try {
                result = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Failed to parse API response:', responseText.substring(0, 500));
                throw new Error('Invalid JSON response from API');
            }

            console.log('Parsed result type:', typeof result);
            console.log('Result keys:', Object.keys(result || {}));

            // Check for error response
            if (result.error) {
                console.log('API returned error:', result.error);
                throw new Error(result.error);
            }

            // Handle the response - could be DATA array or COLUMNS/DATA format
            let products = [];
            if (result.DATA && Array.isArray(result.DATA)) {
                products = result.DATA;
            } else if (result.COLUMNS && result.DATA) {
                // Convert COLUMNS/DATA format to array of objects
                products = this.convertColumnsData(result.COLUMNS, result.DATA);
            } else if (Array.isArray(result)) {
                products = result;
            }

            console.log(`Received ${products.length} products`);

            // Update products in database (API already filters by instock=1)
            let updated = 0;
            let inserted = 0;

            for (const product of products) {
                const normalized = this.normalizeProduct(product);
                const existing = await this.db.findOne({ id: normalized.id });

                if (existing) {
                    await this.db.update({ id: normalized.id }, { $set: normalized });
                    updated++;
                } else {
                    await this.db.insert(normalized);
                    inserted++;
                }
            }

            // Update last sync time
            this.lastSync = new Date();
            await this.db.update(
                { _type: 'meta' },
                { _type: 'meta', lastSync: this.lastSync.toISOString() },
                { upsert: true }
            );

            const totalProducts = await this.getProductCount();

            console.log(`Sync complete. Inserted: ${inserted}, Updated: ${updated}, Total: ${totalProducts}`);

            this.isSyncing = false;
            this.emit('syncCompleted', { inserted, updated, total: totalProducts });

            return {
                success: true,
                inserted,
                updated,
                total: totalProducts
            };

        } catch (error) {
            console.error('Product sync failed:', error.message);
            this.isSyncing = false;
            this.emit('syncFailed', error);

            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Convert ColdFusion COLUMNS/DATA format to array of objects
     */
    convertColumnsData(columns, data) {
        if (!Array.isArray(columns) || !Array.isArray(data)) {
            return [];
        }

        return data.map(row => {
            const obj = {};
            columns.forEach((col, idx) => {
                obj[col] = row[idx];
            });
            return obj;
        });
    }

    /**
     * Normalize product data from Proteus API
     * Maps fields from /webservices/items/ response
     */
    normalizeProduct(product) {
        // Handle both lowercase and uppercase field names (CF can return either)
        const id = product.id || product.ID;
        const sku = product.sku || product.SKU || product.csn || product.CSN || '';
        const name = product.name || product.NAME || product.artist_name || product.ARTIST_NAME || '';
        const description = product.description || product.DESCRIPTION || '';
        const price = parseFloat(product.price || product.PRICE || 0);
        const salePrice = parseFloat(product.sale_price || product.SALE_PRICE || 0);
        const category = product.cat || product.CAT || product.category || product.CATEGORY || 'Uncategorized';
        const brand = product.brand || product.BRAND || product.record_label || product.RECORD_LABEL || '';
        const inventory = product.inv || product.INV || product.cached_inventory || product.CACHED_INVENTORY || 0;
        const image = product.image || product.IMAGE || '';
        const upc = product.upc || product.UPC || '';
        const active = product.active !== undefined ? product.active : (product.ACTIVE !== undefined ? product.ACTIVE : 1);
        const uom = product.uom || product.UOM || 'each';

        // Parse category_ids from comma-separated string to array
        const categoryIdsStr = product.category_ids || product.CATEGORY_IDS || '';
        const categoryIds = categoryIdsStr ? categoryIdsStr.split(',').map(id => id.trim()) : [];

        // Inventory display rules fields
        const inventoryItem = product.inventory_item !== undefined ? product.inventory_item :
                              (product.INVENTORY_ITEM !== undefined ? product.INVENTORY_ITEM : 1);
        const showNoInventory = product.shownoinventory !== undefined ? product.shownoinventory :
                                (product.SHOWNOINVENTORY !== undefined ? product.SHOWNOINVENTORY : 0);
        const removeAtInventory = product.removeatinventory !== undefined ? product.removeatinventory :
                                  (product.REMOVEATINVENTORY !== undefined ? product.REMOVEATINVENTORY : 0);

        // Unit weight for purchase limit calculations (grams)
        const unitweight = parseFloat(product.unitweight || product.UNITWEIGHT || 0);

        return {
            id: String(id),
            upc: upc,
            sku: sku,
            name: name,
            description: description,
            price: salePrice > 0 && salePrice < price ? salePrice : price, // Use sale price if valid
            regularPrice: price,
            salePrice: salePrice,
            cost: parseFloat(product.cost || product.COST || 0),
            taxable: true, // Default to taxable, can be updated per product
            taxRate: 0.0825, // Default tax rate - will use from settings
            category: category,
            categoryIds: categoryIds, // Array of all category IDs this product belongs to
            brand: brand,
            inStock: parseInt(inventory) || 0,
            imageUrl: image,
            uom: uom,
            unitweight: unitweight, // Weight in grams for purchase limit calculations
            active: active == 1 || active === true,
            parentId: product.parentid || product.PARENTID || null,
            modified: product.modified || product.MODIFIED || null,
            created: product.created || product.CREATED || null,
            lastUpdated: new Date().toISOString(),
            // Inventory display rules
            inventoryItem: inventoryItem == 1 || inventoryItem === true,
            showNoInventory: showNoInventory == 1 || showNoInventory === true,
            removeAtInventory: parseInt(removeAtInventory) || 0
        };
    }

    /**
     * Search products by name, UPC, or SKU
     */
    async searchProducts(query, limit = 50) {
        if (!query || query.length < 1) {
            return [];
        }

        const searchTerm = query.toLowerCase().trim();

        // Check if it looks like a UPC/SKU (mostly numbers)
        const isCode = /^\d+$/.test(searchTerm);

        let results;

        if (isCode) {
            // Exact match on UPC or SKU first
            results = await this.db.find({
                $or: [
                    { upc: searchTerm },
                    { sku: searchTerm }
                ],
                _type: { $exists: false }
            }).limit(limit);

            // If no exact match, try partial
            if (results.length === 0) {
                results = await this.db.find({
                    $or: [
                        { upc: new RegExp(searchTerm, 'i') },
                        { sku: new RegExp(searchTerm, 'i') }
                    ],
                    _type: { $exists: false }
                }).limit(limit);
            }
        } else {
            // Search by name
            results = await this.db.find({
                name: new RegExp(searchTerm, 'i'),
                _type: { $exists: false }
            }).limit(limit);
        }

        return results;
    }

    /**
     * Get product by UPC (exact match)
     */
    async getProductByUPC(upc) {
        return await this.db.findOne({ upc: upc, _type: { $exists: false } });
    }

    /**
     * Get product by ID
     */
    async getProductById(id) {
        return await this.db.findOne({ id: id, _type: { $exists: false } });
    }

    /**
     * Get products by category
     * Searches by category ID in the product's categoryIds array
     */
    async getProductsByCategory(categoryIdOrName, limit = 100) {
        console.log('=== GET PRODUCTS BY CATEGORY ===');
        console.log('Input category ID/Name:', categoryIdOrName);

        let categoryId = String(categoryIdOrName);
        let categoryIdsToSearch = [categoryId];

        // First, try to find as a parent category
        const parentCat = await this.categoryDb.findOne({
            isParent: true,
            $or: [
                { id: categoryId },
                { name: categoryIdOrName }
            ]
        });

        if (parentCat) {
            console.log('Found parent category:', parentCat.name, 'ID:', parentCat.id);
            categoryId = parentCat.id;
            categoryIdsToSearch = [categoryId];

            // Also include all subcategory IDs for parent category search
            if (parentCat.subcategories && parentCat.subcategories.length > 0) {
                const subIds = parentCat.subcategories.map(s => String(s.id));
                categoryIdsToSearch = [categoryId, ...subIds];
                console.log('Including subcategory IDs:', subIds);
            }
        } else {
            // Look for it as a subcategory within parent categories
            const allParents = await this.categoryDb.find({ isParent: true });
            for (const parent of allParents) {
                if (parent.subcategories) {
                    const sub = parent.subcategories.find(s =>
                        String(s.id) === categoryId || s.name === categoryIdOrName
                    );
                    if (sub) {
                        console.log('Found subcategory:', sub.name, 'ID:', sub.id, 'under parent:', parent.name);
                        categoryId = sub.id;
                        categoryIdsToSearch = [categoryId];
                        break;
                    }
                }
            }
        }

        console.log('Searching products with category IDs:', categoryIdsToSearch);

        // Search products where any of the categoryIds match
        // NeDB doesn't have $elemMatch for arrays, so we need to use $in with each element
        const allProducts = await this.db.find({ _type: { $exists: false } });

        // Filter products that have any of the search IDs in their categoryIds array
        const products = allProducts.filter(product => {
            if (!product.categoryIds || !Array.isArray(product.categoryIds)) {
                return false;
            }
            return product.categoryIds.some(catId => categoryIdsToSearch.includes(String(catId)));
        }).slice(0, limit);

        console.log('Found products:', products.length);

        // Debug: if no products found, show some stats
        if (products.length === 0) {
            const productsWithCategoryIds = allProducts.filter(p => p.categoryIds && p.categoryIds.length > 0);
            console.log('Products with categoryIds:', productsWithCategoryIds.length, 'of', allProducts.length);

            if (productsWithCategoryIds.length > 0) {
                // Show sample of category IDs in products
                const sampleCategoryIds = new Set();
                productsWithCategoryIds.slice(0, 10).forEach(p => {
                    p.categoryIds.forEach(id => sampleCategoryIds.add(id));
                });
                console.log('Sample category IDs from products:', [...sampleCategoryIds]);
            }
        }

        return products;
    }

    /**
     * Escape special regex characters
     */
    escapeRegex(str) {
        if (!str) return '';
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Get all categories (only parent categories with their subcategories)
     */
    async getCategories() {
        const categories = await this.categoryDb.find({ isParent: true });

        // If no categories table, extract from products
        if (categories.length === 0) {
            const products = await this.db.find({ _type: { $exists: false } });
            const categorySet = new Set();
            products.forEach(p => {
                if (p.category) categorySet.add(p.category);
            });
            return Array.from(categorySet).sort().map(name => ({ name, id: name }));
        }

        // Sort categories by name
        return categories.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }

    /**
     * Get category tax info by ID
     * Returns addtax (category tax rate) and mitsreportable (excise taxable flag)
     */
    async getCategoryTaxInfo(categoryId) {
        const catId = String(categoryId);

        // Check parent categories first
        const parentCat = await this.categoryDb.findOne({
            isParent: true,
            id: catId
        });

        if (parentCat) {
            return {
                addtax: parentCat.addtax || 0,
                mitsreportable: parentCat.mitsreportable || false
            };
        }

        // Check subcategories
        const allParents = await this.categoryDb.find({ isParent: true });
        for (const parent of allParents) {
            if (parent.subcategories) {
                const sub = parent.subcategories.find(s => String(s.id) === catId);
                if (sub) {
                    return {
                        addtax: sub.addtax || 0,
                        mitsreportable: sub.mitsreportable || false
                    };
                }
            }
        }

        // Default if not found
        return { addtax: 0, mitsreportable: false };
    }

    /**
     * Get all products (paginated)
     */
    async getAllProducts(page = 1, limit = 100) {
        const skip = (page - 1) * limit;
        const products = await this.db.find({ _type: { $exists: false } })
            .sort({ name: 1 })
            .skip(skip)
            .limit(limit);

        const total = await this.getProductCount();

        return {
            products,
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        };
    }

    /**
     * Get product count
     */
    async getProductCount() {
        return await this.db.count({ _type: { $exists: false } });
    }

    /**
     * Get cache status
     */
    async getStatus() {
        const productCount = await this.getProductCount();
        const categories = await this.getCategories();
        const packageCount = await this.getPackageCount();

        // Calculate next sync time
        let nextSync = null;
        if (this.lastSync && this.syncTimer) {
            nextSync = new Date(this.lastSync.getTime() + this.syncInterval);
        }

        return {
            productCount,
            categoryCount: categories.length,
            packageCount,
            lastSync: this.lastSync,
            lastPackageSync: this.lastPackageSync,
            nextSync,
            syncIntervalMinutes: this.syncInterval / 60000,
            isSyncing: this.isSyncing,
            isOnline: this.isOnline,
            apiConfigured: !!(this.apiBaseUrl && this.apiKey)
        };
    }

    /**
     * Clear all cached data
     */
    async clearCache() {
        await this.db.remove({}, { multi: true });
        await this.categoryDb.remove({}, { multi: true });

        // Delete and recreate package database to clear old indexes
        const packageDbPath = path.join(this.userDataPath, 'package-cache.db');
        try {
            // Close/reset the database reference
            this.packageDb = null;

            // Delete the file if it exists
            if (fs.existsSync(packageDbPath)) {
                fs.unlinkSync(packageDbPath);
                console.log('Deleted package-cache.db to reset indexes');
            }

            // Recreate the database with correct indexes
            this.packageDb = Datastore.create({
                filename: packageDbPath,
                autoload: true
            });
            await this.packageDb.ensureIndex({ fieldName: 'internalId', unique: true });
            await this.packageDb.ensureIndex({ fieldName: 'packageId' });
            await this.packageDb.ensureIndex({ fieldName: 'productId' });
        } catch (err) {
            console.error('Error resetting package database:', err.message);
            // Fallback: just clear documents
            if (this.packageDb) {
                await this.packageDb.remove({}, { multi: true });
            }
        }

        this.lastSync = null;
        this.lastPackageSync = null;

        // Clear the meta document so sync times are reset
        try {
            await this.db.remove({ _type: 'meta' }, {});
        } catch (e) {
            console.error('Failed to clear meta:', e.message);
        }

        console.log('Product cache cleared');
        return { success: true };
    }

    /**
     * Import products manually (for testing or initial load)
     */
    async importProducts(products) {
        let imported = 0;

        for (const product of products) {
            try {
                const normalized = this.normalizeProduct(product);
                const existing = await this.db.findOne({ id: normalized.id });

                if (existing) {
                    await this.db.update({ id: normalized.id }, { $set: normalized });
                } else {
                    await this.db.insert(normalized);
                }
                imported++;
            } catch (e) {
                console.error('Failed to import product:', e.message);
            }
        }

        console.log(`Imported ${imported} products`);
        return { success: true, imported };
    }

    /**
     * Shutdown the service
     */
    shutdown() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
        console.log('Product cache service shut down');
    }
}

module.exports = ProductCacheService;
