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
  'microporosa', 'fio guia', 'atadura', 'equipo', 'poliflexo',
  'scalp', 'gelco', 'lancita', 'fio cirurgico', 'fio cirúrgico',
  'lamin', 'lâmina', 'bisturi', 'coletor de urina', 'caixa de perfuro',
  'papel grau', 'papel lençol', 'avental', 'ovidracaina', 'agulha',
  'soro fisiologico', 'soro fisiológico', 'glicose'
];

function isMaterial(name) {
  const l = name.toLowerCase().trim();
  return MAT_KW.some(k => l.includes(k));
}

function excelDateToISO(v) {
  if (v == null) return null;
  const n = Number(v);
  if (n > 40000 && n < 50000) {
    const d = new Date((n - 25569) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function parseDayMonthToAugust(s) {
  if (!s) return null;
  const p = String(s).trim().split('/');
  if (p.length !== 2) return null;
  const day = parseInt(p[0]);
  if (isNaN(day)) return null;
  return `2026-08-${String(day).padStart(2, '0')}`;
}

async function run() {
  const client = await pool.connect();
  try {
    console.log('=== LENDO PLANILHA ===');
    const wb = XLSX.readFile('C:/Users/frank/Downloads/PLANILHA_SISTEMA.xlsx');
    const ws = wb.Sheets['Agosto'];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const hdr2 = data[1];

    const dayCols = [];
    if (hdr2) {
      hdr2.forEach((h, i) => {
        if (h && typeof h === 'string' && h.match(/^\d+\/\d+$/)) {
          dayCols.push({ col: i, label: h, dateISO: parseDayMonthToAugust(h) });
        }
      });
    }
    console.log('Datas mapeadas:', dayCols.map(d => `${d.label}→${d.dateISO}`).join(', '));

    const rawProducts = [];
    for (let r = 2; r < data.length; r++) {
      const row = data[r];
      if (!row || !row[0] || typeof row[0] !== 'string') continue;
      const name = row[0].trim();
      if (!name || name.toLowerCase() === 'medicamento') continue;

      const vencRaw = row[1] != null ? row[1] : null;
      const vencISO = excelDateToISO(vencRaw);
      const nf = row[2] != null && String(row[2]).trim() !== '' && String(row[2]) !== 'NF'
        ? String(row[2]).trim() : null;
      const ent = row[3] != null && String(row[3]).trim() !== '' && String(row[3]) !== 'ENT.'
        ? Number(row[3]) : null;
      const estInicial = row[4] != null ? Number(row[4]) : 0;
      const estAtual = row[5] != null ? Number(row[5]) : estInicial;
      const tipo = isMaterial(name) ? 'material' : 'medicamento';

      const movs = [];
      for (const dc of dayCols) {
        const qty = Number(row[dc.col]);
        if (qty > 0) movs.push({ dateISO: dc.dateISO, dateLabel: dc.label, qty });
      }

      rawProducts.push({ name, tipo, vencISO, nf, ent, estInicial, estAtual, movs });
    }

    const merged = new Map();
    for (const p of rawProducts) {
      const key = p.tipo + '|' + p.name.toLowerCase();
      if (merged.has(key)) {
        const e = merged.get(key);
        if (p.vencISO && !e.vencISO) e.vencISO = p.vencISO;
        if (p.nf && !e.nf) e.nf = p.nf;
        if (p.ent != null && (e.ent == null || p.ent > e.ent)) e.ent = p.ent;
        e.estInicial = Math.max(e.estInicial, p.estInicial);
        e.estAtual = Math.max(e.estAtual, p.estAtual);
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
    const withVenc = products.filter(p => p.vencISO).length;
    const withNF = products.filter(p => p.nf).length;

    console.log(`\nPlanilha bruta: ${rawProducts.length} → Após merge: ${products.length}`);
    console.log(`  Medicamentos: ${meds.length}`);
    console.log(`  Materiais: ${mats.length}`);
    console.log(`  Com validade: ${withVenc}`);
    console.log(`  Com NF: ${withNF}`);
    console.log(`  Movimentações: ${totalMovs}\n`);

    // BATCH INSERT products
    console.log('=== INSERINDO PRODUTOS ===');
    const BATCH = 50;
    const pidMap = new Map();

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
        if (p.vencISO) obs.push(`Validade: ${p.vencISO}`);
        obs.push('Planilha: Agosto');
        values.push(`($${pi},$${pi+1},$${pi+2},'unidade',true,$${pi+3})`);
        params.push(p.name, p.tipo, code, obs.join(' | '));
        pi += 4;
      }
      const res = await client.query(
        `INSERT INTO produtos (nome,tipo,codigo,unidade,ativo,observacao)
         VALUES ${values.join(',')} RETURNING id, nome`, params
      );
      for (const r of res.rows) pidMap.set(r.nome.toLowerCase(), r.id);
    }
    console.log(`  ✅ ${products.length} produtos inseridos\n`);

    // INSERT medicamentos + materiais details + estoques
    console.log('=== INSERINDO DETALHES + ESTOQUES ===');
    const medVals = [], medPs = [], matVals = [], matPs = [];
    const estVals = [], estPs = [];
    let mpi = 1, mti = 1, epi = 1;

    for (const p of products) {
      const pid = pidMap.get(p.name.toLowerCase());
      if (p.tipo === 'medicamento') {
        medVals.push(`($${mpi},$${mpi+1},$${mpi+2})`);
        medPs.push(pid, p.vencISO || null, p.nf || null);
        mpi += 3;
      } else {
        matVals.push(`($${mti},$${mti+1},$${mti+2})`);
        matPs.push(pid, p.vencISO || null, p.nf || null);
        mti += 3;
      }
      estVals.push(`($${epi},$${epi+1},$${epi+2},5,200)`);
      estPs.push(pid, p.estInicial, p.estAtual);
      epi += 3;
    }

    if (medVals.length > 0) {
      await client.query(
        `INSERT INTO medicamentos (produto_id,vencimento,nota_fiscal) VALUES ${medVals.join(',')}`, medPs
      );
    }
    if (matVals.length > 0) {
      await client.query(
        `INSERT INTO materiais (produto_id,vencimento,nota_fiscal) VALUES ${matVals.join(',')}`, matPs
      );
    }
    await client.query(
      `INSERT INTO estoques (produto_id,estoque_inicial,quantidade_atual,estoque_minimo,estoque_maximo)
       VALUES ${estVals.join(',')}`, estPs
    );
    console.log(`  ✅ ${meds.length} medicamentos + ${mats.length} materiais + ${products.length} estoques\n`);

    // BATCH INSERT movements
    console.log('=== INSERINDO MOVIMENTAÇÕES ===');
    const allMovs = [];
    for (const p of products) {
      const pid = pidMap.get(p.name.toLowerCase());
      if (!pid) continue;
      const sorted = [...p.movs].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
      for (const m of sorted) allMovs.push({ pid, qty: m.qty, date: m.dateISO, label: m.dateLabel });
    }

    const stockTracker = new Map();
    for (const p of products) stockTracker.set(pidMap.get(p.name.toLowerCase()), p.estAtual);
    allMovs.sort((a, b) => a.date.localeCompare(b.date));

    for (let i = 0; i < allMovs.length; i += BATCH) {
      const batch = allMovs.slice(i, i + BATCH);
      const values = [], params = [];
      let pi = 1;
      for (const m of batch) {
        const antes = stockTracker.get(m.pid) || 0;
        const depois = Math.max(0, antes - m.qty);
        stockTracker.set(m.pid, depois);
        values.push(`($${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},'importacao')`);
        params.push(m.pid, 'saida', m.qty, antes, depois, m.date, `Saída ${m.label}`);
        pi += 7;
      }
      await client.query(
        `INSERT INTO movimentacoes
          (produto_id,tipo,quantidade,estoque_anterior,estoque_posterior,data,observacao,origem)
         VALUES ${values.join(',')}`, params
      );
    }
    console.log(`  ✅ ${allMovs.length} movimentações inseridas\n`);

    // Update stock
    console.log('=== ATUALIZANDO ESTOQUES ===');
    for (const [pid, qty] of stockTracker) {
      await client.query(`UPDATE estoques SET quantidade_atual = $1 WHERE produto_id = $2`, [qty, pid]);
    }
    console.log(`  ✅ Estoques atualizados\n`);

    // VALIDATION
    console.log('=== VALIDAÇÃO ===');
    const vProd = (await client.query('SELECT COUNT(*) FROM produtos')).rows[0].count;
    const vMed = (await client.query("SELECT COUNT(*) FROM produtos WHERE tipo='medicamento'")).rows[0].count;
    const vMat = (await client.query("SELECT COUNT(*) FROM produtos WHERE tipo='material'")).rows[0].count;
    const vEst = (await client.query('SELECT COUNT(*) FROM estoques')).rows[0].count;
    const vMov = (await client.query('SELECT COUNT(*) FROM movimentacoes')).rows[0].count;
    const vVenc = (await client.query("SELECT COUNT(*) FROM medicamentos WHERE vencimento IS NOT NULL")).rows[0].count;
    const vVencMat = (await client.query("SELECT COUNT(*) FROM materiais WHERE vencimento IS NOT NULL")).rows[0].count;
    const vNF = (await client.query("SELECT COUNT(*) FROM medicamentos WHERE nota_fiscal IS NOT NULL")).rows[0].count;
    const vNFMat = (await client.query("SELECT COUNT(*) FROM materiais WHERE nota_fiscal IS NOT NULL")).rows[0].count;

    console.log(`Produtos: ${vProd} (esperado: ${products.length})`);
    console.log(`  Medicamentos: ${vMed} (esperado: ${meds.length})`);
    console.log(`  Materiais: ${vMat} (esperado: ${mats.length})`);
    console.log(`Estoques: ${vEst}`);
    console.log(`Movimentações: ${vMov} (esperado: ${allMovs.length})`);
    console.log(`Validade medicamentos: ${vVenc}`);
    console.log(`Validade materiais: ${vVencMat}`);
    console.log(`NF medicamentos: ${vNF}`);
    console.log(`NF materiais: ${vNFMat}`);

    // Date distribution
    const dateDist = await client.query(`
      SELECT to_char(data,'YYYY-MM-DD') as dt, COUNT(*) as qtd, SUM(quantidade) as total
      FROM movimentacoes GROUP BY dt ORDER BY dt
    `);
    console.log('\nDistribuição por data:');
    dateDist.rows.forEach(r => console.log(`  ${r.dt}: ${r.qtd} movs, ${r.total} unid`));

    console.log('\n✅ IMPORTAÇÃO CONCLUÍDA');

  } catch (err) {
    console.error('❌ ERRO:', err.message);
    throw err;
  } finally {
    await client.release();
    await pool.end();
  }
}

run();
