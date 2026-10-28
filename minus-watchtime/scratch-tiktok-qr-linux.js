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
        
        console.log("Waiting 5 seconds for page load...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log("Taking screenshot...");
        await page.screenshot({ path: '/var/www/watchtime/tiktok_login.png' });
        console.log("Screenshot saved!");
        
    } catch (err) {
        console.error("Error:", err);
    } finally {
        await browser.close();
    }
}

run();
