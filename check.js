const fs = require('fs'); 
const html = fs.readFileSync('public/index.html', 'utf8'); 
const js = html.split('<script>')[1].split('</script>')[0]; 
const body = html.split('<body')[1].split('<script>')[0]; 
const idsInJs = Array.from(js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)).map(m => m[1]); 
const missing = new Set(); 
for (const id of idsInJs) { 
  if (!body.includes('id="' + id + '"') && !body.includes('id=\'' + id + '\'')) { 
    missing.add(id); 
  } 
} 
console.log('Missing IDs:', Array.from(missing).join(', '));
