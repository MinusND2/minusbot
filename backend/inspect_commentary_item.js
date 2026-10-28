const fs = require('fs');
const data = JSON.parse(fs.readFileSync('espn_match_760449.json', 'utf8'));
const item = data.commentary.find(i => i.text && i.text.includes('Fourth official'));
console.log("Commentary item keys & structure:", JSON.stringify(item, null, 2));
