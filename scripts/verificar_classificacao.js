require('dotenv').config();
const XLSX = require('xlsx');
const { Pool } = require('pg');
const wb = XLSX.readFile('C:\\Users\\frank\\Downloads\\PLANILHA_SISTEMA.xlsx');
const ws = wb.Sheets['Agosto'];
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

// Row 148 (0-indexed 147) = "Materiais" header
// Rows 0-146: medications, rows 149+: materials
const meds = [];
const mats = [];
for (let r = 0; r < data.length; r++) {
  const row = data[r];
  const name = typeof row[0] === 'string' ? row[0].trim() : '';
  if (!name || name.length < 2) continue;
  if (r <= 146) meds.push(name.toLowerCase());
  else if (r >= 149) mats.push(name.toLowerCase());
}

console.log('Spreadsheet medications:', meds.length);
console.log('Spreadsheet materials:', mats.length);

const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const dbMeds = await p.query("SELECT nome, tipo FROM produtos ORDER BY tipo, LOWER(nome)");
  const dbMedsList = dbMeds.rows.filter(r => r.tipo === 'medicamento').map(r => r.nome.toLowerCase());
  const dbMatsList = dbMeds.rows.filter(r => r.tipo === 'material').map(r => r.nome.toLowerCase());
  
  console.log('DB medications:', dbMedsList.length);
  console.log('DB materials:', dbMatsList.length);
  
  console.log('\n=== DB medications NOT in spreadsheet meds (should be material) ===');
  let wrong = 0;
  for (const name of dbMedsList) {
    if (!meds.includes(name)) {
      console.log('  ⚠️  ' + name);
      wrong++;
    }
  }
  if (wrong === 0) console.log('  ✅ All correct');
  
  console.log('\n=== DB materials NOT in spreadsheet mats (should be medication) ===');
  wrong = 0;
  for (const name of dbMatsList) {
    if (!mats.includes(name)) {
      console.log('  ⚠️  ' + name);
      wrong++;
    }
  }
  if (wrong === 0) console.log('  ✅ All correct');
  
  await p.end();
})();
