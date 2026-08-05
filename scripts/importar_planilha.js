require('dotenv').config();
const { Pool } = require('pg');
const XLSX = require('xlsx');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAT_KW = [
  'luva', 'mascara', 'seringa', 'gaze', 'alcool', 'clorexidina',
  'touca', 'tipoia', 'tornerinha', 'aguja', 'banda', 'esparadrapo',
  'papel toalha', 'absorvente', 'sonda', 'cateter', 'escova degermante',
  'microporosa', 'fio guia'
];

function isMaterial(name) {
  const l = name.toLowerCase().trim();
  return MAT_KW.some(k => l.includes(k));
}

function excelDateToISO(v) {
  if (!v) return null;
  const n = Number(v);
  if (n > 40000 && n < 50000) {
    const d = new Date((n - 25569) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function parseDayMonth(s) {
  if (!s) return null;
  const p = String(s).trim().split('/');
  if (p.length !== 2) return null;
  const day = parseInt(p[0]), month = parseInt(p[1]);
  if (isNaN(day) || isNaN(month)) return null;
  return `2026-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

async function run() {
  const client = await pool.connect();
  try {
    console.log('=== LENDO PLANILHA ===');
    const wb = XLSX.readFile('C:/Users/frank/Downloads/PLANILHA_SISTEMA.xlsx');
    const ws = wb.Sheets['Agosto'];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const hdr = data[1];

    const dayCols = [];
    if (hdr) {
      hdr.forEach((h, i) => {
        if (h && typeof h === 'string' && h.match(/^\d+\/\d+$/)) {
          dayCols.push({ col: i, dateISO: parseDayMonth(h), label: h });
        }
      });
    }

    const rawProducts = [];
    for (let r = 2; r < data.length; r++) {
      const row = data[r];
      if (!row || !row[0] || typeof row[0] !== 'string') continue;
      const name = row[0].trim();
      if (!name || name.toLowerCase() === 'medicamento') continue;

      const nf = row[2] != null ? String(row[2]).trim() : null;
      const ent = row[3] != null ? Number(row[3]) : null;
      const estInicial = row[4] != null ? Number(row[4]) : 0;
      const estAtual = row[5] != null ? Number(row[5]) : estInicial;
      const tipo = isMaterial(name) ? 'material' : 'medicamento';

      const movs = [];
      for (const dc of dayCols) {
        const qty = Number(row[dc.col]);
        if (qty > 0) movs.push({ dateISO: dc.dateISO, dateLabel: dc.label, qty });
      }

      rawProducts.push({ name, tipo, nf, ent, estInicial, estAtual, movs });
    }

    const merged = new Map();
    for (const p of rawProducts) {
      const key = p.tipo + '|' + p.name.toLowerCase();
      if (merged.has(key)) {
        const e = merged.get(key);
        e.estInicial = Math.max(e.estInicial, p.estInicial);
        e.estAtual = Math.max(e.estAtual, p.estAtual);
        if (p.nf && !e.nf) e.nf = p.nf;
        const eDates = new Set(e.movs.map(m => m.dateISO));
        for (const m of p.movs) {
          if (!eDates.has(m.dateISO)) { e.movs.push(m); eDates.add(m.dateISO); }
        }
      } else {
        merged.set(key, { ...p });
      }
    }

    const products = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const meds = products.filter(p => p.tipo === 'medicamento');
    const mats = products.filter(p => p.tipo === 'material');
    const totalMovs = products.reduce((s, p) => s + p.movs.length, 0);

    console.log(`Planilha bruta: ${rawProducts.length} → Após merge: ${products.length}`);
    console.log(`  Medicamentos: ${meds.length}, Materiais: ${mats.length}, Movimentações: ${totalMovs}\n`);

    // BATCH INSERT products
    console.log('=== INSERINDO PRODUTOS (BATCH) ===');
    const BATCH = 50;
    const allIds = [];

    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let pi = 1;

      for (let j = 0; j < batch.length; j++) {
        const p = batch[j];
        const code = (p.tipo === 'material' ? 'MAT' : 'MED') + String(i + j + 1).padStart(3, '0');
        const obs = [];
        if (p.nf) obs.push(`NF: ${p.nf}`);
        obs.push('Origem: Planilha');
        values.push(`($${pi},$${pi+1},$${pi+2},'unidade',true,$${pi+3})`);
        params.push(p.name, p.tipo, code, obs.join(' | '));
        pi += 4;
      }

      const res = await client.query(
        `INSERT INTO produtos (nome,tipo,codigo,unidade,ativo,observacao)
         VALUES ${values.join(',')} RETURNING id, nome`,
        params
      );

      for (const r of res.rows) {
        allIds.push({ id: r.id, nome: r.nome });
      }

      if ((i + BATCH) % 100 === 0 || i + BATCH >= products.length) {
        console.log(`  ${Math.min(i + BATCH, products.length)}/${products.length}...`);
      }
    }
    console.log(`  ✅ ${allIds.length} produtos inseridos\n`);

    // Build name→id map
    const pidMap = new Map();
    for (const r of allIds) {
      pidMap.set(r.nome.toLowerCase(), r.id);
    }

    // BATCH INSERT medicamentos detail + estoques
    console.log('=== INSERINDO DETALHES + ESTOQUES (BATCH) ===');
    const medValues = [];
    const medParams = [];
    const estValues = [];
    const estParams = [];
    let mpi = 1, epi = 1;

    for (const p of products) {
      const pid = pidMap.get(p.name.toLowerCase());
      medValues.push(`($${mpi})`);
      medParams.push(pid);
      mpi++;

      estValues.push(`($${epi},$${epi+1},$${epi+2},5,200)`);
      estParams.push(pid, p.estInicial, p.estAtual);
      epi += 3;
    }

    await client.query(`INSERT INTO medicamentos (produto_id) VALUES ${medValues.join(',')} ON CONFLICT DO NOTHING`, medParams);
    await client.query(
      `INSERT INTO estoques (produto_id,estoque_inicial,quantidade_atual,estoque_minimo,estoque_maximo)
       VALUES ${estValues.join(',')}`,
      estParams
    );
    console.log(`  ✅ ${products.length} detalhes + estoques inseridos\n`);

    // BATCH INSERT movements
    console.log('=== INSERINDO MOVIMENTAÇÕES (BATCH) ===');
    const allMovs = [];
    for (const p of products) {
      const pid = pidMap.get(p.name.toLowerCase());
      if (!pid) continue;
      const sorted = [...p.movs].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
      for (const m of sorted) {
        allMovs.push({ pid, qty: m.qty, date: m.dateISO, label: m.dateLabel });
      }
    }

    let estoqueCorrente = new Map();
    for (const p of products) {
      estoqueCorrente.set(pidMap.get(p.name.toLowerCase()), p.estAtual);
    }

    // Sort movements by date
    allMovs.sort((a, b) => a.date.localeCompare(b.date));

    for (let i = 0; i < allMovs.length; i += BATCH) {
      const batch = allMovs.slice(i, i + BATCH);
      const values = [];
      const params = [];
      let pi = 1;

      for (const m of batch) {
        const antes = estoqueCorrente.get(m.pid) || 0;
        const depois = Math.max(0, antes - m.qty);
        estoqueCorrente.set(m.pid, depois);

        values.push(`($${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},'importacao')`);
        params.push(m.pid, 'saida', m.qty, antes, depois, m.date, `Saída ${m.label}`);
        pi += 7;
      }

      await client.query(
        `INSERT INTO movimentacoes
          (produto_id, tipo, quantidade, estoque_anterior, estoque_posterior, data, observacao, origem)
         VALUES ${values.join(',')}`,
        params
      );
    }
    console.log(`  ✅ ${allMovs.length} movimentações inseridas\n`);

    // UPDATE stock
    console.log('=== ATUALIZANDO ESTOQUES ===');
    const estUpdateValues = [];
    const estUpdateParams = [];
    let eui = 1;
    for (const [pid, qty] of estoqueCorrente) {
      estUpdateValues.push(` WHEN produto_id = $${eui} THEN $${eui+1}`);
      estUpdateParams.push(pid, qty);
      eui += 2;
    }
    // Use individual updates (safer than CASE with many params)
    for (const [pid, qty] of estoqueCorrente) {
      await client.query(`UPDATE estoques SET quantidade_atual = $1 WHERE produto_id = $2`, [qty, pid]);
    }
    console.log(`  ✅ ${estoqueCorrente.size} estoques atualizados\n`);

    // Validation
    console.log('=== VALIDAÇÃO FINAL ===');
    const vp = (await client.query('SELECT COUNT(*) FROM produtos')).rows[0].count;
    const vm = (await client.query("SELECT COUNT(*) FROM produtos WHERE tipo='medicamento'")).rows[0].count;
    const vmt = (await client.query("SELECT COUNT(*) FROM produtos WHERE tipo='material'")).rows[0].count;
    const ve = (await client.query('SELECT COUNT(*) FROM estoques')).rows[0].count;
    const vmov = (await client.query('SELECT COUNT(*) FROM movimentacoes')).rows[0].count;
    const vsai = (await client.query("SELECT COUNT(*) FROM movimentacoes WHERE tipo='saida'")).rows[0].count;
    const vtq = (await client.query("SELECT COALESCE(SUM(quantidade),0) FROM movimentacoes WHERE tipo='saida'")).rows[0].sum;

    console.log(`Produtos: ${vp} (esperado: ${products.length})`);
    console.log(`  Medicamentos: ${vm} (esperado: ${meds.length})`);
    console.log(`  Materiais: ${vmt} (esperado: ${mats.length})`);
    console.log(`Estoques: ${ve}`);
    console.log(`Movimentações: ${vmov} (esperado: ${allMovs.length})`);
    console.log(`Saídas: ${vsai}`);
    console.log(`Quantidade total: ${vtq}`);
    console.log('\n✅ IMPORTAÇÃO CONCLUÍDA COM SUCESSO');

  } catch (err) {
    console.error('❌ ERRO:', err.message);
    throw err;
  } finally {
    await client.release();
    await pool.end();
  }
}

run();
