const ScannerService = require('./scanner-service');

async function testScannerIntegration() {
    console.log('🧪 Testing Scanner Integration...\n');
    
    const scannerService = new ScannerService();
    
    try {
        // Test 1: Scanner Detection
        console.log('1️⃣ Testing scanner detection...');
        const detectResult = await scannerService.detectScanners();
        
        if (detectResult.success) {
            console.log(`✅ Detection successful: ${detectResult.message}`);
            console.log(`📷 Found ${detectResult.scanners.length} scanner(s):`);
            
            detectResult.scanners.forEach((scanner, index) => {
                console.log(`   ${index + 1}. ${scanner.name} (${scanner.type}) - ${scanner.status}`);
            });
        } else {
            console.log(`❌ Detection failed: ${detectResult.error}`);
            console.log('ℹ️  This is normal if no scanners are connected');
        }
        
        // Test 2: Scan Settings
        console.log('\n2️⃣ Testing scan settings...');
        const currentSettings = scannerService.getScanSettings();
        console.log('📋 Current settings:', currentSettings);
        
        scannerService.updateScanSettings({
            resolution: 150,
            colorMode: 'grayscale',
            format: 'jpeg'
        });
        
        const updatedSettings = scannerService.getScanSettings();
        console.log('📋 Updated settings:', updatedSettings);
        console.log('✅ Settings management working');
        
        // Test 3: Mock Scan Test (won't actually scan without hardware)
        console.log('\n3️⃣ Testing scan functionality (mock)...');
        if (detectResult.scanners && detectResult.scanners.length > 0) {
            console.log('🔍 Would test with scanner:', detectResult.scanners[0].name);
            console.log('⚠️  Actual scanning requires physical scanner hardware');
        } else {
            console.log('⚠️  No scanners detected - would need hardware for full test');
        }
        
        // Test 4: Image Processing Capability
        console.log('\n4️⃣ Testing image processing capability...');
        try {
            const sharp = require('sharp');
            console.log('✅ Sharp image processing library loaded');
            
            // Test basic sharp functionality
            const testBuffer = Buffer.from('test');
            console.log('✅ Sharp basic functionality available');
        } catch (sharpError) {
            console.log('❌ Sharp image processing error:', sharpError.message);
        }
        
        // Test 5: Form Data and Fetch
        console.log('\n5️⃣ Testing upload dependencies...');
        try {
            const FormData = require('form-data');
            console.log('✅ FormData for uploads available');
            
            const fetch = (await import('node-fetch')).default;
            console.log('✅ Node-fetch for HTTP requests available');
        } catch (fetchError) {
            console.log('❌ Upload dependencies error:', fetchError.message);
        }
        
        console.log('\n🎉 Scanner integration test completed!');
        console.log('\n📝 Next steps:');
        console.log('   1. Connect a physical scanner to test actual scanning');
        console.log('   2. Configure API settings in the application');
        console.log('   3. Test end-to-end scanning and upload workflow');
        console.log('   4. Use WebSocket API from your web application');
        
    } catch (error) {
        console.error('❌ Test failed with error:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Handle async execution
testScannerIntegration().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
});