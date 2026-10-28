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

        console.log("Clicking 'Use QR code'...");
        try {
            const qrBtn = await page.waitForSelector('xpath///div[contains(text(), "Use QR code")]', { timeout: 3000 });
            if (qrBtn) {
                await qrBtn.click();
                console.log("Clicked using xpath!");
            }
        } catch (e) {
            console.log("XPath wait failed, trying alternative...");
            const divElements = await page.$$('div');
            for (let el of divElements) {
                let text = await page.evaluate(el => el.textContent, el);
                if (text && text.includes('Use QR code')) {
                    await el.click();
                    console.log("Clicked using text match!");
                    break;
                }
            }
        }

        console.log("Waiting 5 seconds for QR code to load...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log("Analyzing page elements...");
        const details = await page.evaluate(() => {
            const qrWrap = document.querySelector('div[data-e2e="qr-code"]');
            if (!qrWrap) return "No data-e2e='qr-code' wrapper found!";
            return {
                outerHTML: qrWrap.outerHTML,
                canvasExists: !!qrWrap.querySelector('canvas'),
                imgExists: !!qrWrap.querySelector('img'),
                imgSrc: qrWrap.querySelector('img') ? qrWrap.querySelector('img').src : null
            };
        });
        console.log("Details:", JSON.stringify(details, null, 2));
        
    } catch (err) {
        console.error("Error:", err);
    } finally {
        await browser.close();
    }
}

run();
