require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  // Get all products with their current type
  const r = await p.query(`SELECT id, nome, tipo FROM produtos ORDER BY LOWER(nome)`);
  
  // Known medications that should NOT be materials
  const KNOWN_MEDS = [
    'bupivacaina', 'glicose 25%', 'glicose 50%', 'glicose 5%',
    'soro glicosado', 'soro glicofisiologico', 'soro ringer',
    'solucao ringer', 'solucao fisiologica', 'agua para injecao',
    'lidocaina', 'vidracaina', 'bupivacaina'
  ];
  
  // Known materials that should NOT be medications
  const KNOWN_MATS = [
    'agulha', 'alcool 70', 'algodao', 'atadura', 'avental',
    'caixa de perfuro', 'cateter', 'coletor de urina', 'clorexidina',
    'equipo', 'escova degermante', 'esparadrapo', 'fio cirurgico',
    'fio cirúrgico', 'gazes', 'gelco', 'grau cirurgico', 'grau cirúrgico',
    'lamina de bisturi', 'lâmina de bisturi', 'lancita', 'luva',
    'mascara descartavel', 'mascara nebulizacao', 'mascara nebulização',
    'mascara nao', 'mascara não', 'medidor de pressao', 'ovidracaina',
    'papel grau', 'papel lençol', 'papel toalha', 'poliflexo',
    'prestobarba', 'pulseira', 'scalp', 'seringa', 'sonda',
    'soro fisiologico', 'soro fisiológico', 'touca', 'tipoia',
    'tornerinha', 'papel ecg', 'pro-pe', 'pró-pé'
  ];
  
  function shouldBeMaterial(name) {
    const l = name.toLowerCase().trim();
    // Check if it's a known medication first
    if (KNOWN_MEDS.some(k => l.includes(k))) return false;
    // Check if it's a known material
    return KNOWN_MATS.some(k => l.includes(k));
  }
  
  let toUpdate = [];
  for (const row of r.rows) {
    const shouldBe = shouldBeMaterial(row.nome) ? 'material' : 'medicamento';
    if (row.tipo !== shouldBe) {
      toUpdate.push({ id: row.id, nome: row.nome, atual: row.tipo, novo: shouldBe });
    }
  }
  
  console.log(`Total products: ${r.rows.length}`);
  console.log(`Need reclassification: ${toUpdate.length}`);
  console.log('\nProducts to reclassify:');
  toUpdate.forEach(p => console.log(`  "${p.nome}" : ${p.atual} → ${p.novo}`));
  
  await p.end();
})();
