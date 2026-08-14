require('dotenv').config({ path: '.env.local' });
const xlsx = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function seed() {
  const wb = xlsx.readFile('../Jul-Aug26.xlsx');
  
  // 1. Seed Categories from Summary Sheet
  const wsSummary = wb.Sheets['Summary'];
  const summaryData = xlsx.utils.sheet_to_json(wsSummary, {header: 1});
  
  const categoriesMap = {};
  
  for (let i = 4; i < summaryData.length; i++) {
    const catName = summaryData[i][1];
    const planned = summaryData[i][2];
    
    if (catName) {
      const { data, error } = await supabase.from('categories').insert([{
        name: catName,
        planned_amount: Number(planned) || 0
      }]).select();
      if (!error && data) {
        categoriesMap[catName] = data[0].id;
      } else {
        // If it already exists (like Uncategorized)
        const { data: exist } = await supabase.from('categories').select('id').eq('name', catName).single();
        if (exist) categoriesMap[catName] = exist.id;
      }
    }
  }

  // 2. Seed Transactions
  const wsTx = wb.Sheets['Transactions'];
  const txData = xlsx.utils.sheet_to_json(wsTx, {header: 1});

  const txs = [];

  for (let i = 4; i < txData.length; i++) {
    const row = txData[i];
    
    // Outgoing
    if (row[0] && row[1]) {
      const date = xlsx.SSF.parse_date_code(row[0]);
      const dStr = new Date(date.y, date.m - 1, date.d).toISOString();
      
      let catId = categoriesMap[row[3]];
      
      txs.push({
        kind: 'outgoing',
        transaction_date: dStr,
        amount: Number(row[1]),
        source_or_merchant: row[2] || '',
        category_id: catId || null,
        note: ''
      });
    }

    // Incoming
    if (row[5] && row[6]) {
      const date = xlsx.SSF.parse_date_code(row[5]);
      const dStr = new Date(date.y, date.m - 1, date.d).toISOString();
      
      txs.push({
        kind: 'incoming',
        transaction_date: dStr,
        amount: Number(row[6]),
        source_or_merchant: row[7] || '',
        note: row[8] || ''
      });
    }
  }

  const { error } = await supabase.from('transactions').insert(txs);
  if (error) {
    console.error('Error inserting transactions:', error);
  } else {
    console.log(`Successfully seeded ${txs.length} transactions!`);
  }
}

seed();
