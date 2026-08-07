const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_BDhMwt0plX9L@ep-aged-union-ay0y0k5u-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const encRes = await pool.query('SHOW client_encoding');
  console.log('Client encoding:', encRes.rows[0].client_encoding);
  
  const srvRes = await pool.query('SHOW server_encoding');
  console.log('Server encoding:', srvRes.rows[0].server_encoding);
  
  // Check a product with accented name
  const res = await pool.query("SELECT nome FROM produtos WHERE nome ILIKE '%algod%' LIMIT 1");
  const row = res.rows[0];
  console.log('\nProduct: ' + row.nome);
  
  for (let i = 0; i < row.nome.length; i++) {
    const c = row.nome.charCodeAt(i);
    if (c > 127) {
      console.log('  Char ' + i + ': U+' + c.toString(16).toUpperCase().padStart(4, '0'));
    }
  }

  // Check several products with known accents
  const res2 = await pool.query("SELECT nome FROM produtos WHERE nome ILIKE '%ção%' OR nome ILIKE '%ão%' OR nome ILIKE '%último%' OR nome ILIKE '%á%' LIMIT 5");
  console.log('\nProducts with accents:');
  for (const r of res2.rows) {
    let chars = '';
    for (let i = 0; i < r.nome.length; i++) {
      const c = r.nome.charCodeAt(i);
      if (c > 127) chars += ' U+' + c.toString(16).toUpperCase().padStart(4, '0');
    }
    console.log('  ' + r.nome + (chars ? ' [' + chars + ']' : ' [no accents]'));
  }

  // Check total counts
  const countRes = await pool.query('SELECT COUNT(*) as total FROM produtos');
  console.log('\nTotal products: ' + countRes.rows[0].total);

  const movCount = await pool.query('SELECT COUNT(*) as total FROM movimentacoes');
  console.log('Total movements: ' + movCount.rows[0].total);

  await pool.end();
}
check().catch(e => console.error(e.message));
