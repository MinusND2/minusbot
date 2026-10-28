const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

async function run() {
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
        await page.goto('https://www.tiktok.com/login', { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Click QR login
        const qrBtn = await page.waitForSelector('xpath///div[contains(text(), "Use QR code")]', { timeout: 3000 });
        if (qrBtn) await qrBtn.click();
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Inspect elements
        const elements = await page.evaluate(() => {
            const results = [];
            
            // Find all divs or buttons that might represent login options
            // TikTok options usually have text, icons, or specific roles
            document.querySelectorAll('div').forEach((el) => {
                const text = el.textContent ? el.textContent.trim() : '';
                if (text && (text.includes('QR') || text.includes('phone') || text.includes('Google') || text.includes('Facebook'))) {
                    // Only log if it seems like a button/container itself (has children or is a direct option)
                    if (el.children.length > 0 && el.children.length < 5) {
                        results.push({
                            text: text,
                            className: el.className,
                            tagName: el.tagName,
                            hasCanvas: !!el.querySelector('canvas'),
                            html: el.outerHTML.slice(0, 150)
                        });
                    }
                }
            });
            
            return results;
        });
        
        console.log("Found elements:", JSON.stringify(elements, null, 2));
        
    } catch (err) {
        console.error("Error:", err);
    } finally {
        await browser.close();
    }
}

run();
