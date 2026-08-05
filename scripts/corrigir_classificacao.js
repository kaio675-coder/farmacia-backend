require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const MOVES_TO_MATERIAL = [
    'Compressas de cirurgica',
    'Eletrodo',
    'Fita adesiva autoclave',
    'Fita  hospitalar  16mmx50m',
    'Fita autoclave 19mmx30m',
    'Fita para ECG',
    'Fita para glicemia',
    'Medidor de pressão',
    'Oculos',
    'Lanceta',
    'Lacre verde',
    'lacre laranja',
    'Gel para Ultrasson',
    'Glicerina',
    'Humidificador',
    'Formol 10% Formaldeído',
    'Fralda adulto',
    'Fraldas geriátricas Tam G e M',
    'Scapl 27G',
    'Materiais',
    'Espaçador para medicamento',
    'Especulo vaginal M, G e P',
    'Extensor O2',
    'Filtro hme',
    'Fleet enema',
  ];

  let moved = 0;
  for (const nome of MOVES_TO_MATERIAL) {
    const r = await p.query(
      "UPDATE produtos SET tipo = 'material' WHERE LOWER(nome) = LOWER($1) AND tipo = 'medicamento' RETURNING id, nome, tipo",
      [nome]
    );
    for (const row of r.rows) {
      const existing = await p.query("SELECT id FROM materiais WHERE produto_id = $1", [row.id]);
      if (!existing.rows.length) {
        const medRec = await p.query("SELECT vencimento, nota_fiscal FROM medicamentos WHERE produto_id = $1", [row.id]);
        const venc = medRec.rows.length ? medRec.rows[0].vencimento : null;
        const nf = medRec.rows.length ? medRec.rows[0].nota_fiscal : null;
        await p.query("INSERT INTO materiais (produto_id, vencimento, nota_fiscal) VALUES ($1, $2, $3)", [row.id, venc, nf]);
        await p.query("DELETE FROM medicamentos WHERE produto_id = $1", [row.id]);
        console.log(`✅ "${row.nome}" → material`);
        moved++;
      }
    }
  }
  
  if (moved === 0) console.log('Nenhum produto movido');
  
  const meds = await p.query("SELECT COUNT(*) FROM produtos WHERE tipo = 'medicamento'");
  const mats = await p.query("SELECT COUNT(*) FROM produtos WHERE tipo = 'material'");
  console.log(`\nMedicamentos: ${meds.rows[0].count}`);
  console.log(`Materiais: ${mats.rows[0].count}`);
  await p.end();
})();
