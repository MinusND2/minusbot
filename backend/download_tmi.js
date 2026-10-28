const https = require('https');
const fs = require('fs');
const path = require('path');

const urls = [
    "https://cdnjs.cloudflare.com/ajax/libs/tmi.js/1.8.5/tmi.min.js",
    "https://unpkg.com/tmi.js@1.8.5/dist/tmi.min.js",
    "https://cdn.jsdelivr.net/npm/tmi.js@1.8.5/dist/tmi.min.js"
];
const dest = path.join(__dirname, "../public/tmi.min.js");

function tryDownload(index) {
    if (index >= urls.length) {
        console.error("All CDNs returned error or 404.");
        process.exit(1);
    }
    const url = urls[index];
    console.log(`Trying to download from: ${url}`);
    https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
            // Follow redirect
            const redirectUrl = res.headers.location;
            console.log(`Following redirect to: ${redirectUrl}`);
            https.get(redirectUrl, (redRes) => {
                handleResponse(redRes, index);
            });
        } else {
            handleResponse(res, index);
        }
    }).on('error', (err) => {
        console.error(`Error on CDN ${url}:`, err.message);
        tryDownload(index + 1);
    });
}

function handleResponse(res, index) {
    if (res.statusCode !== 200) {
        console.warn(`CDN returned status code ${res.statusCode}. Trying next...`);
        tryDownload(index + 1);
        return;
    }
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => {
        file.close();
        console.log("Download complete!");
        process.exit(0);
    });
}

tryDownload(0);
