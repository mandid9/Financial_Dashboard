const fs = require('fs');

const htmlPath = 'C:\\Users\\Muhamed\\finance-dashboard\\Index.html';
const outPath = 'C:\\Users\\Muhamed\\finance-dashboard\\finance-dashboard-next\\public\\index.html';

let html = fs.readFileSync(htmlPath, 'utf8');

// Replace the old server() wrapper with a standard fetch() wrapper pointing to our Next.js API
const newServerFn = `
function server(fnName, args = [], onSuccess = null, loadingMsg = null) {
  if (loadingMsg) toast(loadingMsg, 'info');
  return fetch(fnName === 'getDashboardData' || fnName === 'getBudgetSettings' ? '/api/dashboard' : '/api/action', {
    method: fnName === 'getDashboardData' || fnName === 'getBudgetSettings' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: fnName === 'getDashboardData' || fnName === 'getBudgetSettings' ? undefined : JSON.stringify({ action: fnName, args })
  })
  .then(res => res.json())
  .then(res => {
    if (res.error) throw new Error(res.error);
    
    // For GET /api/dashboard, the old UI expects two separate calls. We bundled them in one endpoint.
    let finalRes = res;
    if (fnName === 'getDashboardData') finalRes = res.dashboard;
    if (fnName === 'getBudgetSettings') finalRes = res.budget;

    if (onSuccess) onSuccess(finalRes);
    return finalRes;
  })
  .catch(err => {
    console.error(err);
    toast('Error: ' + (err.message || err), 'error');
    throw err;
  });
}
`;

html = html.replace(/function server\([\s\S]*?\}\s*\}\s*/, newServerFn);

fs.writeFileSync(outPath, html, 'utf8');
console.log('Frontend HTML ported to public directory with fetch() logic.');
