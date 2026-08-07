require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:8888'];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes('*')) {
      callback(null, origin);
    } else if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, origin);
    } else {
      callback(new Error('Não permitido pelo CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('✅ Conectado ao Neon PostgreSQL'))
  .catch(err => console.error('❌ Erro ao conectar:', err.message));

// =========================================================
// VIEW para retornar dados no formato que o frontend espera
// =========================================================
async function ensureView() {
  await pool.query(`DO $$ BEGIN
    ALTER TABLE medicamentos ADD COLUMN IF NOT EXISTS data_fabricacao DATE;
  EXCEPTION WHEN duplicate_column THEN NULL;
  END $$;`);
  await pool.query(`DO $$ BEGIN
    ALTER TABLE materiais ADD COLUMN IF NOT EXISTS data_fabricacao DATE;
  EXCEPTION WHEN duplicate_column THEN NULL;
  END $$;`);

  const sql = `
    CREATE OR REPLACE VIEW v_produtos_completo AS
    SELECT
      p.id,
      p.nome,
      p.tipo,
      p.codigo,
      p.unidade,
      p.ativo,
      COALESCE(p.observacao, '') AS observacao,
      COALESCE(m.vencimento, mt.vencimento) AS validade,
      COALESCE(m.nota_fiscal, mt.nota_fiscal) AS nf,
      COALESCE(m.entrada, mt.entrada, 0) AS entrada_qtd,
      COALESCE(e.estoque_inicial, 0) AS estoque_inicial,
      COALESCE(e.quantidade_atual, 0) AS estoque_atual,
      COALESCE(e.estoque_minimo, 0) AS estoque_minimo,
      COALESCE(e.estoque_maximo, 0) AS estoque_maximo,
      (SELECT numero_lote FROM lotes WHERE produto_id = p.id ORDER BY criado_em DESC LIMIT 1) AS lote,
      (SELECT validade FROM lotes WHERE produto_id = p.id ORDER BY criado_em DESC LIMIT 1) AS lote_validade,
      (SELECT quantidade FROM lotes WHERE produto_id = p.id ORDER BY criado_em DESC LIMIT 1) AS lote_quantidade,
      m.principio_ativo,
      m.dosagem,
      m.forma_farmaceutica,
      m.apresentacao,
      m.fabricante AS fabricante_med,
      m.controlado,
      mt.fabricante AS fabricante_mat,
      COALESCE(m.data_fabricacao, mt.data_fabricacao) AS data_fabricacao
    FROM produtos p
    LEFT JOIN medicamentos m ON m.produto_id = p.id
    LEFT JOIN materiais mt ON mt.produto_id = p.id
    LEFT JOIN estoques e ON e.produto_id = p.id
  `;
  await pool.query(sql);
}

ensureView().catch(err => console.error('Erro ao criar view:', err.message));

async function ensureAuditTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS logs_auditoria (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      acao VARCHAR(100) NOT NULL,
      tabela VARCHAR(100) NOT NULL,
      dados_anteriores JSONB,
      dados_novos JSONB,
      criado_em TIMESTAMP DEFAULT NOW()
    )
  `;
  await pool.query(sql);
}
ensureAuditTable().catch(err => console.error('Erro ao criar tabela de auditoria:', err.message));

// =========================================================
// ROTAS DE AUTENTICAÇÃO (não requerem auth)
// =========================================================
app.use('/api/auth', require('./routes/auth')(pool));

// =========================================================
// ROTAS QUE REQUEREM AUTENTICAÇÃO
// =========================================================

// Usuarios CRUD (admin only)
app.use('/api/usuarios', require('./routes/usuarios')(pool));

// Importação de movimentações
app.use('/api/movimentacoes', require('./routes/importacao')(pool));

// Sistema de backup
app.use('/api/backup', require('./routes/backup')(pool));

// =========================================================
// HELPERS
// =========================================================
function mapProduto(row) {
  if (!row) return null;
  return {
    id: row.id,
    nome: row.nome,
    tipo: row.tipo,
    codigo: row.codigo || '',
    categoria: row.tipo === 'material' ? 'Material' : 'Medicamento',
    unidade: row.unidade || 'unidade',
    ativo: row.ativo,
    observacao: row.observacao || '',
    estoqueInicial: Number(row.estoque_inicial) || 0,
    estoqueAtual: Number(row.estoque_atual) || 0,
    estoqueMinimo: Number(row.estoque_minimo) || 0,
    estoqueMaximo: Number(row.estoque_maximo) || 0,
    lote: row.lote || '',
    validade: row.validade ? row.validade.toISOString().slice(0, 10) : '',
    localizacao: '',
    nf: row.nf || '',
    entradaQtd: Number(row.entrada_qtd) || 0,
    principio_ativo: row.principio_ativo || '',
    dosagem: row.dosagem || '',
    forma_farmaceutica: row.forma_farmaceutica || '',
    apresentacao: row.apresentacao || '',
    fabricante: row.fabricante_med || row.fabricante_mat || '',
    controlado: row.controlado || false,
    dataFabricacao: row.data_fabricacao ? row.data_fabricacao.toISOString().slice(0, 10) : ''
  };
}

function mapMovimentacao(row) {
  if (!row) return null;
  return {
    id: row.id,
    data: row.data ? row.data.toISOString().slice(0, 10) : '',
    hora: row.data ? row.data.toTimeString().slice(0, 5) : '',
    medicamento: row.produto_nome || '',
    produto_id: row.produto_id,
    tipo: row.tipo === 'entrada' ? 'Entrada' : row.tipo === 'saida' ? 'Saída' : 'Ajuste',
    quantidade: Number(row.quantidade) || 0,
    estoqueAnterior: Number(row.estoque_anterior) || 0,
    estoquePosterior: Number(row.estoque_posterior) || 0,
    nf: row.nf || '',
    lote: row.lote || '',
    responsavel: row.responsavel || '',
    observacao: row.observacao || '',
    origem: row.origem || 'manual'
  };
}

// =========================================================
// ROTAS DE PRODUTOS (protegidas)
// =========================================================
app.get('/api/produtos', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM v_produtos_completo ORDER BY LOWER(nome)');
    res.json(result.rows.map(mapProduto));
  } catch (err) {
    console.error('Erro GET /api/produtos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/produtos/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM v_produtos_completo WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(mapProduto(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/produtos', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = req.body;
    const tipo = p.tipo === 'material' ? 'material' : 'medicamento';

    const prodResult = await client.query(
      `INSERT INTO produtos (nome, tipo, codigo, unidade, ativo, observacao)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [p.nome, tipo, p.codigo || null, p.unidade || 'unidade', p.ativo !== false, p.observacao || '']
    );
    const produtoId = prodResult.rows[0].id;

    if (tipo === 'medicamento') {
      await client.query(
        `INSERT INTO medicamentos (produto_id, vencimento, nota_fiscal, entrada, data_fabricacao)
         VALUES ($1, $2, $3, $4, $5)`,
        [produtoId, p.validade || null, p.nf || null, p.entradaQtd || 0, p.dataFabricacao || null]
      );
    } else {
      await client.query(
        `INSERT INTO materiais (produto_id, vencimento, nota_fiscal, entrada, data_fabricacao)
         VALUES ($1, $2, $3, $4, $5)`,
        [produtoId, p.validade || null, p.nf || null, p.entradaQtd || 0, p.dataFabricacao || null]
      );
    }

    await client.query(
      `INSERT INTO estoques (produto_id, estoque_inicial, quantidade_atual, estoque_minimo, estoque_maximo)
       VALUES ($1, $2, $3, $4, $5)`,
      [produtoId, p.estoqueInicial || 0, p.estoqueAtual || 0, p.estoqueMinimo || 0, p.estoqueMaximo || 0]
    );

    if (p.lote) {
      await client.query(
        `INSERT INTO lotes (produto_id, numero_lote, validade, quantidade)
         VALUES ($1, $2, $3, $4) ON CONFLICT (produto_id, numero_lote) DO UPDATE SET
         validade=EXCLUDED.validade, quantidade=EXCLUDED.quantidade`,
        [produtoId, p.lote, p.validade || null, p.estoqueAtual || 0]
      );
    } else if (p.validade) {
      const autoLote = `LOTE-${Date.now()}`;
      await client.query(
        `INSERT INTO lotes (produto_id, numero_lote, validade, quantidade)
         VALUES ($1, $2, $3, $4)`,
        [produtoId, autoLote, p.validade, p.estoqueAtual || 0]
      );
    }

    await client.query('COMMIT');
    const result = await pool.query('SELECT * FROM v_produtos_completo WHERE id = $1', [produtoId]);
    res.status(201).json(mapProduto(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro POST /api/produtos:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/produtos', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Esperado um array' });

    for (const p of items) {
      if (!p.id) continue;
      const tipo = p.tipo === 'material' ? 'material' : 'medicamento';

      await client.query(
        `UPDATE produtos SET nome=$1, tipo=$2, codigo=$3, unidade=$4, ativo=$5, observacao=$6, updated_at=NOW()
         WHERE id=$7`,
        [p.nome, tipo, p.codigo || null, p.unidade || 'unidade', p.ativo !== false, p.observacao || '', p.id]
      );

      if (tipo === 'medicamento') {
        await client.query(
          `INSERT INTO medicamentos (produto_id, vencimento, nota_fiscal, entrada, data_fabricacao)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (produto_id) DO UPDATE SET vencimento=EXCLUDED.vencimento, nota_fiscal=EXCLUDED.nota_fiscal, entrada=EXCLUDED.entrada, data_fabricacao=EXCLUDED.data_fabricacao`,
          [p.id, p.validade || null, p.nf || null, p.entradaQtd || 0, p.dataFabricacao || null]
        );
      } else {
        await client.query(
          `INSERT INTO materiais (produto_id, vencimento, nota_fiscal, entrada, data_fabricacao)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (produto_id) DO UPDATE SET vencimento=EXCLUDED.vencimento, nota_fiscal=EXCLUDED.nota_fiscal, entrada=EXCLUDED.entrada, data_fabricacao=EXCLUDED.data_fabricacao`,
          [p.id, p.validade || null, p.nf || null, p.entradaQtd || 0, p.dataFabricacao || null]
        );
      }

      await client.query(
        `INSERT INTO estoques (produto_id, estoque_inicial, quantidade_atual, estoque_minimo, estoque_maximo)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (produto_id) DO UPDATE SET
         estoque_inicial=EXCLUDED.estoque_inicial, quantidade_atual=EXCLUDED.quantidade_atual,
         estoque_minimo=EXCLUDED.estoque_minimo, estoque_maximo=EXCLUDED.estoque_maximo, updated_at=NOW()`,
        [p.id, p.estoqueInicial || 0, p.estoqueAtual || 0, p.estoqueMinimo || 0, p.estoqueMaximo || 0]
      );

      if (p.lote) {
        await client.query(
          `INSERT INTO lotes (produto_id, numero_lote, validade, quantidade)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (produto_id, numero_lote) DO UPDATE SET validade=EXCLUDED.validade, quantidade=EXCLUDED.quantidade`,
          [p.id, p.lote, p.validade || null, p.estoqueAtual || 0]
        );
      } else if (p.validade) {
        const existingLotes = await client.query(
          `SELECT id FROM lotes WHERE produto_id = $1`, [p.id]
        );
        if (existingLotes.rows.length > 0) {
          await client.query(
            `UPDATE lotes SET validade = $1, quantidade = $2 WHERE produto_id = $3`,
            [p.validade, p.estoqueAtual || 0, p.id]
          );
        } else {
          const autoLote = `LOTE-${Date.now()}`;
          await client.query(
            `INSERT INTO lotes (produto_id, numero_lote, validade, quantidade)
             VALUES ($1, $2, $3, $4)`,
            [p.id, autoLote, p.validade, p.estoqueAtual || 0]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, updated: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro PUT /api/produtos:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/produtos/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = req.body;
    const id = req.params.id;
    const tipo = p.tipo === 'material' ? 'material' : 'medicamento';

    await client.query(
      `UPDATE produtos SET nome=$1, tipo=$2, codigo=$3, unidade=$4, ativo=$5, observacao=$6, updated_at=NOW()
       WHERE id=$7`,
      [p.nome, tipo, p.codigo || null, p.unidade || 'unidade', p.ativo !== false, p.observacao || '', id]
    );

    if (tipo === 'medicamento') {
      await client.query(
        `INSERT INTO medicamentos (produto_id, vencimento, nota_fiscal, entrada, data_fabricacao)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (produto_id) DO UPDATE SET vencimento=EXCLUDED.vencimento, nota_fiscal=EXCLUDED.nota_fiscal, entrada=EXCLUDED.entrada, data_fabricacao=EXCLUDED.data_fabricacao`,
        [id, p.validade || null, p.nf || null, p.entradaQtd || 0, p.dataFabricacao || null]
      );
    } else {
      await client.query(
        `INSERT INTO materiais (produto_id, vencimento, nota_fiscal, entrada, data_fabricacao)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (produto_id) DO UPDATE SET vencimento=EXCLUDED.vencimento, nota_fiscal=EXCLUDED.nota_fiscal, entrada=EXCLUDED.entrada, data_fabricacao=EXCLUDED.data_fabricacao`,
        [id, p.validade || null, p.nf || null, p.entradaQtd || 0, p.dataFabricacao || null]
      );
    }

    await client.query(
      `INSERT INTO estoques (produto_id, estoque_inicial, quantidade_atual, estoque_minimo, estoque_maximo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (produto_id) DO UPDATE SET
       estoque_inicial=EXCLUDED.estoque_inicial, quantidade_atual=EXCLUDED.quantidade_atual,
       estoque_minimo=EXCLUDED.estoque_minimo, estoque_maximo=EXCLUDED.estoque_maximo, updated_at=NOW()`,
      [id, p.estoqueInicial || 0, p.estoqueAtual || 0, p.estoqueMinimo || 0, p.estoqueMaximo || 0]
    );

    if (p.lote) {
      await client.query(
        `INSERT INTO lotes (produto_id, numero_lote, validade, quantidade)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (produto_id, numero_lote) DO UPDATE SET validade=EXCLUDED.validade, quantidade=EXCLUDED.quantidade`,
        [id, p.lote, p.validade || null, p.estoqueAtual || 0]
      );
    } else if (p.validade) {
      const existingLotes = await client.query(
        `SELECT id, numero_lote FROM lotes WHERE produto_id = $1`, [id]
      );
      if (existingLotes.rows.length > 0) {
        await client.query(
          `UPDATE lotes SET validade = $1, quantidade = $2 WHERE produto_id = $3`,
          [p.validade, p.estoqueAtual || 0, id]
        );
      } else {
        const autoLote = `LOTE-${Date.now()}`;
        await client.query(
          `INSERT INTO lotes (produto_id, numero_lote, validade, quantidade)
           VALUES ($1, $2, $3, $4)`,
          [id, autoLote, p.validade, p.estoqueAtual || 0]
        );
      }
    } else {
      await client.query(`DELETE FROM lotes WHERE produto_id = $1`, [id]);
    }

    await client.query('COMMIT');
    const result = await pool.query('SELECT * FROM v_produtos_completo WHERE id = $1', [id]);
    res.json(mapProduto(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/produtos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE produtos SET ativo = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// ROTAS DE MOVIMENTAÇÕES (protegidas)
// =========================================================
app.get('/api/movimentacoes', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, p.nome AS produto_nome,
        COALESCE((SELECT numero_lote FROM lotes WHERE produto_id = m.produto_id LIMIT 1), '') AS lote,
        COALESCE(
          (SELECT nota_fiscal FROM medicamentos WHERE produto_id = m.produto_id LIMIT 1),
          (SELECT nota_fiscal FROM materiais WHERE produto_id = m.produto_id LIMIT 1),
          ''
        ) AS nf,
        COALESCE(u.nome, '') AS responsavel
      FROM movimentacoes m
      LEFT JOIN produtos p ON p.id = m.produto_id
      LEFT JOIN usuarios u ON u.id = m.responsavel_id
      ORDER BY m.data DESC
    `);
    res.json(result.rows.map(mapMovimentacao));
  } catch (err) {
    console.error('Erro GET /api/movimentacoes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/movimentacoes/exportar - Exportar movimentações com filtros
app.get('/api/movimentacoes/exportar', requireAuth, async (req, res) => {
  try {
    const { dataInicio, dataFim, tipo, origem, produto, responsavel } = req.query;
    let where = [];
    let params = [];
    let idx = 1;

    if (dataInicio) { where.push(`m.data >= $${idx++}`); params.push(dataInicio); }
    if (dataFim) { where.push(`m.data <= $${idx++}`); params.push(dataFim); }
    if (tipo && tipo !== 'todos') { where.push(`m.tipo = $${idx++}`); params.push(tipo === 'Entrada' ? 'entrada' : tipo === 'Saída' ? 'saida' : 'ajuste'); }
    if (origem && origem !== 'todos') { where.push(`m.origem = $${idx++}`); params.push(origem); }
    if (produto && produto !== 'todos') { where.push(`p.nome = $${idx++}`); params.push(produto); }
    if (responsavel && responsavel !== 'todos') { where.push(`u.nome = $${idx++}`); params.push(responsavel); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await pool.query(`
      SELECT m.*, p.nome AS produto_nome, p.codigo AS produto_codigo,
        COALESCE(u.nome, '') AS responsavel
      FROM movimentacoes m
      LEFT JOIN produtos p ON p.id = m.produto_id
      LEFT JOIN usuarios u ON u.id = m.responsavel_id
      ${whereClause}
      ORDER BY m.data DESC
    `, params);
    res.json(result.rows.map(mapMovimentacao));
  } catch (err) {
    console.error('Erro GET /api/movimentacoes/exportar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/movimentacoes', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mov = req.body;

    const tipoLower = (mov.tipo || '').toLowerCase();
    const tipoDb = tipoLower.includes('entrada') ? 'entrada' : tipoLower.includes('saida') || tipoLower.includes('saída') ? 'saida' : 'ajuste';

    const estoqueResult = await client.query(
      'SELECT quantidade_atual FROM estoques WHERE produto_id = $1',
      [mov.produto_id]
    );
    const estoqueAtual = estoqueResult.rows.length ? Number(estoqueResult.rows[0].quantidade_atual) : 0;
    let estoquePosterior;

    if (tipoDb === 'entrada') {
      estoquePosterior = estoqueAtual + Number(mov.quantidade);
    } else if (tipoDb === 'saida') {
      estoquePosterior = estoqueAtual - Number(mov.quantidade);
      if (estoquePosterior < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Estoque insuficiente' });
      }
    } else {
      estoquePosterior = Number(mov.estoquePosterior || mov.quantidade);
    }

    // =========================================================
    // LOTES: Criar ou atualizar lote PRIMEIRO (para obter lote_id)
    // =========================================================
    let loteId = null;
    let loteInfo = null;

    if (tipoDb === 'entrada') {
      const loteNum = mov.lote && mov.lote.toString().trim() ? mov.lote.toString().trim() : null;
      const validade = mov.validade || null;

      if (loteNum) {
        const existingLote = await client.query(
          'SELECT id, quantidade FROM lotes WHERE produto_id = $1 AND numero_lote = $2',
          [mov.produto_id, loteNum]
        );

        if (existingLote.rows.length > 0) {
          loteId = existingLote.rows[0].id;
          const qtdAtual = Number(existingLote.rows[0].quantidade) || 0;
          const novaQtd = qtdAtual + Number(mov.quantidade);

          const updateFields = ['quantidade = $1'];
          const updateParams = [novaQtd];
          let paramIdx = 2;

          if (validade) {
            updateFields.push(`validade = $${paramIdx++}`);
            updateParams.push(validade);
          }

          updateParams.push(loteId);
          await client.query(
            `UPDATE lotes SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`,
            updateParams
          );

          loteInfo = { id: loteId, numero_lote: loteNum, validade, quantidade: novaQtd, atualizado: true };
        } else {
          const insertResult = await client.query(
            'INSERT INTO lotes (produto_id, numero_lote, validade, quantidade, data_entrada) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
            [mov.produto_id, loteNum, validade, Number(mov.quantidade)]
          );
          loteId = insertResult.rows[0].id;
          loteInfo = { id: loteId, numero_lote: loteNum, validade, quantidade: Number(mov.quantidade), atualizado: false };
        }
      } else if (validade) {
        const autoLote = `LOTE-${Date.now()}`;
        const insertResult = await client.query(
          'INSERT INTO lotes (produto_id, numero_lote, validade, quantidade, data_entrada) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
          [mov.produto_id, autoLote, validade, Number(mov.quantidade)]
        );
        loteId = insertResult.rows[0].id;
        loteInfo = { id: loteId, numero_lote: autoLote, validade, quantidade: Number(mov.quantidade), atualizado: false };
      }
    }

    // =========================================================
    // Inserir movimentação com lote_id
    // =========================================================
    await client.query(
      `INSERT INTO movimentacoes (produto_id, tipo, quantidade, estoque_anterior, estoque_posterior, data, observacao, responsavel_id, origem, lote_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [mov.produto_id, tipoDb, mov.quantidade, estoqueAtual, estoquePosterior,
       mov.data ? new Date(mov.data + 'T12:00:00Z') : new Date(), mov.observacao || '', req.user.id, 'manual', loteId]
    );

    await client.query(
      'UPDATE estoques SET quantidade_atual = $1, updated_at = NOW() WHERE produto_id = $2',
      [estoquePosterior, mov.produto_id]
    );

    // =========================================================
    // Atualizar data_fabricacao do produto se fornecida na entrada
    // =========================================================
    if (tipoDb === 'entrada' && mov.data_fabricacao) {
      const tipoResult = await client.query('SELECT tipo FROM produtos WHERE id = $1', [mov.produto_id]);
      const prodTipo = tipoResult.rows.length ? tipoResult.rows[0].tipo : 'medicamento';
      const tabela = prodTipo === 'material' ? 'materiais' : 'medicamentos';
      await client.query(
        `UPDATE ${tabela} SET data_fabricacao = $1 WHERE produto_id = $2`,
        [mov.data_fabricacao, mov.produto_id]
      );
    }

    // =========================================================
    // LOTES: Na saída, diminuir quantidade do lote
    // =========================================================
    if (tipoDb === 'saida' && mov.lote && mov.lote.toString().trim()) {
      const loteNum = mov.lote.toString().trim();
      const loteRow = await client.query(
        'SELECT id, quantidade FROM lotes WHERE produto_id = $1 AND numero_lote = $2',
        [mov.produto_id, loteNum]
      );
      if (loteRow.rows.length > 0) {
        const novaQtd = Math.max(0, Number(loteRow.rows[0].quantidade) - Number(mov.quantidade));
        await client.query('UPDATE lotes SET quantidade = $1 WHERE id = $2', [novaQtd, loteRow.rows[0].id]);
      }
    }

    const movResult = await client.query(
      `SELECT m.*, p.nome AS produto_nome FROM movimentacoes m LEFT JOIN produtos p ON p.id = m.produto_id WHERE m.produto_id = $1 ORDER BY m.data DESC, m.id DESC LIMIT 1`,
      [mov.produto_id]
    );

    await client.query('COMMIT');

    const created = movResult.rows[0];
    res.status(201).json({
      ok: true,
      id: created.id,
      produto_id: created.produto_id,
      tipo: created.tipo,
      quantidade: Number(created.quantidade),
      data: created.data ? created.data.toISOString().slice(0, 10) : '',
      estoque_anterior: Number(created.estoque_anterior),
      estoque_posterior: Number(created.estoque_posterior),
      estoquePosterior: Number(created.estoque_posterior),
      observacao: created.observacao || '',
      responsavel_id: created.responsavel_id,
      origem: created.origem || 'manual',
      produto_nome: created.produto_nome || '',
      lote: loteInfo
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro POST /api/movimentacoes:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =========================================================
// RECÁLCULO DE ESTOQUE (helper)
// =========================================================
async function recalcularEstoque(client, produtoId) {
  const estoqueInicialResult = await client.query(
    'SELECT COALESCE(estoque_inicial, 0) AS estoque_inicial FROM estoques WHERE produto_id = $1',
    [produtoId]
  );
  let estoque = estoqueInicialResult.rows.length ? Number(estoqueInicialResult.rows[0].estoque_inicial) : 0;

  const result = await client.query(
    'SELECT id, tipo, quantidade, data FROM movimentacoes WHERE produto_id = $1 ORDER BY data ASC, id ASC',
    [produtoId]
  );
  for (const mov of result.rows) {
    const anterior = estoque;
    if (mov.tipo === 'entrada') {
      estoque += Number(mov.quantidade);
    } else if (mov.tipo === 'saida') {
      estoque -= Number(mov.quantidade);
    } else {
      estoque = Number(mov.quantidade);
    }
    await client.query(
      'UPDATE movimentacoes SET estoque_anterior = $1, estoque_posterior = $2 WHERE id = $3',
      [anterior, estoque, mov.id]
    );
  }
  await client.query(
    'UPDATE estoques SET quantidade_atual = $1, updated_at = NOW() WHERE produto_id = $2',
    [estoque, produtoId]
  );
  return estoque;
}

// =========================================================
// DELETE /api/movimentacoes/:id - Excluir movimentação
// =========================================================
app.delete('/api/movimentacoes/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const movResult = await client.query(
      'SELECT m.*, p.nome AS produto_nome FROM movimentacoes m LEFT JOIN produtos p ON p.id = m.produto_id WHERE m.id = $1',
      [id]
    );
    if (!movResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimentação não encontrada' });
    }
    const mov = movResult.rows[0];

    // Ajustar lote ao excluir movimentação
    if (mov.lote_id) {
      if (mov.tipo === 'entrada') {
        // Excluindo entrada: diminuir quantidade do lote
        await client.query(
          'UPDATE lotes SET quantidade = GREATEST(0, quantidade - $1) WHERE id = $2',
          [Number(mov.quantidade), mov.lote_id]
        );
      } else if (mov.tipo === 'saida') {
        // Excluindo saída: aumentar quantidade do lote
        await client.query(
          'UPDATE lotes SET quantidade = quantidade + $1 WHERE id = $2',
          [Number(mov.quantidade), mov.lote_id]
        );
      }
    }

    await client.query('DELETE FROM movimentacoes WHERE id = $1', [id]);
    const novoEstoque = await recalcularEstoque(client, mov.produto_id);

    await client.query(
      `INSERT INTO logs_auditoria (usuario_id, acao, tabela, dados_anteriores, dados_novos)
       VALUES ($1, 'excluir_movimentacao', 'movimentacoes', $2, $3)`,
      [
        req.user.id,
        JSON.stringify({
          id: mov.id,
          produto: mov.produto_nome,
          tipo: mov.tipo,
          quantidade: Number(mov.quantidade),
          data: mov.data
        }),
        JSON.stringify({ estoque_recalculado: novoEstoque })
      ]
    );

    await client.query('COMMIT');
    res.json({ ok: true, estoqueRecalculado: novoEstoque });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro DELETE /api/movimentacoes/:id:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =========================================================
// PUT /api/movimentacoes/:id - Editar movimentação
// =========================================================
app.put('/api/movimentacoes/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { produto_id, data, quantidade, tipo, observacao, lote, validade } = req.body;
    await client.query('BEGIN');

    const movResult = await client.query(
      'SELECT m.*, p.nome AS produto_nome FROM movimentacoes m LEFT JOIN produtos p ON p.id = m.produto_id WHERE m.id = $1',
      [id]
    );
    if (!movResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimentação não encontrada' });
    }
    const antigo = movResult.rows[0];

    const tipoLower = (tipo || '').toLowerCase();
    const tipoDb = tipoLower.includes('entrada') ? 'entrada' : tipoLower.includes('saida') || tipoLower.includes('saída') ? 'saida' : 'ajuste';
    const dataMov = data ? new Date(data + 'T12:00:00Z') : antigo.data;

    // Reverter lote anterior se existia
    if (antigo.lote_id) {
      if (antigo.tipo === 'entrada') {
        await client.query(
          'UPDATE lotes SET quantidade = GREATEST(0, quantidade - $1) WHERE id = $2',
          [Number(antigo.quantidade), antigo.lote_id]
        );
      } else if (antigo.tipo === 'saida') {
        await client.query(
          'UPDATE lotes SET quantidade = quantidade + $1 WHERE id = $2',
          [Number(antigo.quantidade), antigo.lote_id]
        );
      }
    }

    // Criar/atualizar novo lote se fornecido
    let novoLoteId = null;
    if (lote && lote.toString().trim()) {
      const loteNum = lote.toString().trim();
      const validadeLote = validade || null;

      const existingLote = await client.query(
        'SELECT id, quantidade FROM lotes WHERE produto_id = $1 AND numero_lote = $2',
        [produto_id || antigo.produto_id, loteNum]
      );

      if (existingLote.rows.length > 0) {
        novoLoteId = existingLote.rows[0].id;
        const qtdAtual = Number(existingLote.rows[0].quantidade) || 0;
        let novaQtd;
        if (tipoDb === 'entrada') {
          novaQtd = qtdAtual + Number(quantidade);
        } else if (tipoDb === 'saida') {
          novaQtd = Math.max(0, qtdAtual - Number(quantidade));
        } else {
          novaQtd = qtdAtual;
        }

        const updateFields = ['quantidade = $1'];
        const updateParams = [novaQtd];
        let paramIdx = 2;
        if (validadeLote) {
          updateFields.push(`validade = $${paramIdx++}`);
          updateParams.push(validadeLote);
        }
        updateParams.push(novoLoteId);
        await client.query(`UPDATE lotes SET ${updateFields.join(', ')} WHERE id = $${paramIdx}`, updateParams);
      } else {
        const insertResult = await client.query(
          'INSERT INTO lotes (produto_id, numero_lote, validade, quantidade, data_entrada) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
          [produto_id || antigo.produto_id, loteNum, validadeLote, Number(quantidade)]
        );
        novoLoteId = insertResult.rows[0].id;
      }
    }

    await client.query(
      `UPDATE movimentacoes SET produto_id = $1, tipo = $2, quantidade = $3, data = $4, observacao = $5, lote_id = $6 WHERE id = $7`,
      [produto_id || antigo.produto_id, tipoDb, quantidade, dataMov, observacao !== undefined ? observacao : antigo.observacao, novoLoteId, id]
    );

    const targetProdutoId = produto_id || antigo.produto_id;
    const novoEstoque = await recalcularEstoque(client, targetProdutoId);

    if (targetProdutoId !== antigo.produto_id) {
      await recalcularEstoque(client, antigo.produto_id);
    }

    await client.query(
      `INSERT INTO logs_auditoria (usuario_id, acao, tabela, dados_anteriores, dados_novos)
       VALUES ($1, 'editar_movimentacao', 'movimentacoes', $2, $3)`,
      [
        req.user.id,
        JSON.stringify({
          id: antigo.id,
          produto: antigo.produto_nome,
          tipo: antigo.tipo,
          quantidade: Number(antigo.quantidade),
          data: antigo.data,
          observacao: antigo.observacao
        }),
        JSON.stringify({
          produto_id: produto_id || antigo.produto_id,
          tipo: tipoDb,
          quantidade: Number(quantidade),
          data: dataMov,
          observacao: observacao !== undefined ? observacao : antigo.observacao,
          estoque_recalculado: novoEstoque
        })
      ]
    );

    await client.query('COMMIT');
    res.json({ ok: true, estoqueRecalculado: novoEstoque });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro PUT /api/movimentacoes/:id:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =========================================================
// ROTAS DE LOTES (protegidas)
// =========================================================
app.get('/api/lotes', requireAuth, async (req, res) => {
  try {
    const { produto_id } = req.query;
    let sql = `
      SELECT l.*, p.nome AS produto_nome, p.codigo AS produto_codigo, p.tipo AS produto_tipo
      FROM lotes l
      LEFT JOIN produtos p ON p.id = l.produto_id
      WHERE l.quantidade > 0 AND p.ativo = TRUE
    `;
    const params = [];
    if (produto_id) {
      params.push(produto_id);
      sql += ` AND l.produto_id = $${params.length}`;
    }
    sql += ' ORDER BY p.nome, l.validade ASC NULLS LAST, l.numero_lote';
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro GET /api/lotes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// ROTAS DE CONFIGURAÇÕES (protegidas)
// =========================================================
app.get('/api/configuracoes', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM configuracoes');
    const config = {};
    for (const row of result.rows) {
      config[row.chave] = row.valor;
    }
    res.json(config);
  } catch (err) {
    console.error('Erro GET /api/configuracoes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/configuracoes', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    for (const [chave, valor] of Object.entries(data)) {
      await pool.query(
        `INSERT INTO configuracoes (chave, valor, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [chave, JSON.stringify(valor)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro PUT /api/configuracoes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// Health check para Railway
// =========================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// =========================================================
// Servir o frontend (apenas localmente)
// =========================================================
const fs = require('fs');
const frontendPath = 'E:/SITE FARMACIA';
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// =========================================================
// INICIAR SERVIDOR
// =========================================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
