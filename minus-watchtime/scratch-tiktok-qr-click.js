const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

async function run() {
    console.log("Starting browser...");
    const browser = await puppeteerExtra.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-gpu',
            '--disable-dev-shm-usage'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        
        console.log("Navigating to TikTok login...");
        await page.goto('https://www.tiktok.com/login', { waitUntil: 'networkidle2' });
        
        console.log("Waiting for page load...");
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log("Trying to accept cookies...");
        try {
            const allowAllBtn = await page.waitForSelector('xpath///button[contains(text(), "Allow all")]', { timeout: 3000 });
            if (allowAllBtn) {
                await allowAllBtn.click();
                console.log("Clicked Allow all cookies");
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (e) {
            console.log("No cookie button found:", e.message);
        }
        
        console.log("Clicking 'Use QR code'...");
        try {
            const qrBtn = await page.waitForSelector('xpath///div[contains(text(), "Use QR code")]', { timeout: 3000 });
            if (qrBtn) {
                await qrBtn.click();
                console.log("Clicked Use QR code");
            }
        } catch (e) {
            console.log("Trying alternative selector for QR code...");
            const divElements = await page.$$('div');
            for (let el of divElements) {
                let text = await page.evaluate(el => el.textContent, el);
                if (text && text.includes('Use QR code')) {
                    await el.click();
                    console.log("Clicked alternative Use QR code");
                    break;
                }
            }
        }
        
        console.log("Waiting 5 seconds for QR code...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log("Taking screenshot...");
        await page.screenshot({ path: '/var/www/watchtime/tiktok_qr_code.png' });
        console.log("Screenshot saved!");
        
    } catch (err) {
        console.error("Error:", err);
    } finally {
        await browser.close();
    }
}

run();
