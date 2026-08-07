const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

module.exports = function(pool) {
  const router = express.Router();

  const TABLES = [
    'produtos', 'medicamentos', 'materiais', 'estoques', 'lotes',
    'entradas', 'entrada_itens', 'saidas', 'saida_itens',
    'movimentacoes', 'ajustes_estoque', 'importacoes_movimentacoes',
    'fornecedores', 'usuarios', 'configuracoes', 'logs_auditoria'
  ];

  const SYSTEM_FILES = [
    '../index.html', 'server.js', 'render.yaml', 'package.json',
    'routes/auth.js', 'routes/usuarios.js', 'routes/importacao.js', 'middleware/auth.js'
  ];

  async function ensureBackupTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL,
        nome VARCHAR(200) NOT NULL,
        dados JSONB NOT NULL,
        tamanho BIGINT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'concluido',
        criado_em TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  async function dumpDatabase() {
    const data = {};
    for (const table of TABLES) {
      try {
        const result = await pool.query(`SELECT * FROM ${table}`);
        data[table] = result.rows.map(row => {
          const cleaned = {};
          for (const [k, v] of Object.entries(row)) {
            if (v instanceof Date) cleaned[k] = v.toISOString();
            else if (typeof v === 'object' && v !== null) cleaned[k] = JSON.stringify(v);
            else cleaned[k] = v;
          }
          return cleaned;
        });
      } catch (e) {
        data[table] = [];
      }
    }
    return data;
  }

  async function dumpSystemFiles() {
    const files = {};
    const backendRoot = path.join(__dirname, '..');
    for (const rel of SYSTEM_FILES) {
      const fullPath = path.resolve(backendRoot, rel);
      try {
        if (fs.existsSync(fullPath)) {
          files[rel] = fs.readFileSync(fullPath, 'utf8');
        }
      } catch (e) {}
    }
    try {
      const frontendCandidates = [
        path.join(__dirname, '..', '..', 'frontend', 'index.html'),
        path.join(__dirname, '..', '..', 'site', 'index.html'),
        path.join(__dirname, '..', '..', '..', 'SITE FARMACIA', 'index.html')
      ];
      for (const fp of frontendCandidates) {
        if (fs.existsSync(fp)) {
          files['frontend/index.html'] = fs.readFileSync(fp, 'utf8');
          break;
        }
      }
    } catch (e) {}
    return files;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  router.post('/execute', requireAuth, async (req, res) => {
    try {
      await ensureBackupTable();
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`;
      const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      const nome = `BACKUP_COMPLETO_${dateStr}_${timeStr}`;
      console.log(`Iniciando backup: ${nome}`);
      const [dbData, sysData] = await Promise.all([dumpDatabase(), dumpSystemFiles()]);
      const dados = { database: dbData, sistema: sysData, data: now.toISOString() };
      const dadosJSON = JSON.stringify(dados);
      const tamanho = Buffer.byteLength(dadosJSON, 'utf8');
      await pool.query(
        `INSERT INTO backups (tipo, nome, dados, tamanho, status) VALUES ('completo', $1, $2, $3, 'concluido')`,
        [nome, dados, tamanho]
      );
      await pool.query(
        `INSERT INTO configuracoes (chave, valor, updated_at) VALUES ('ultimo_backup', $1, NOW()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [JSON.stringify({ data: now.toISOString(), nome, tamanho, status: 'concluido' })]
      );
      const verify = await pool.query('SELECT dados FROM backups WHERE nome = $1', [nome]);
      if (!verify.rows.length || !verify.rows[0].dados) {
        throw new Error('Falha na verificacao de integridade');
      }
      const dbTables = Object.keys(verify.rows[0].dados.database || {});
      const sysFiles = Object.keys(verify.rows[0].dados.sistema || {});
      console.log(`Backup concluido: ${nome} (${formatSize(tamanho)})`);
      res.json({ ok: true, nome, tamanho: formatSize(tamanho), tamanhoBytes: tamanho, tabelas: dbTables.length, arquivos: sysFiles.length, data: now.toISOString() });
    } catch (err) {
      console.error('Erro no backup:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/list', requireAuth, async (req, res) => {
    try {
      await ensureBackupTable();
      const result = await pool.query('SELECT id, tipo, nome, tamanho, status, criado_em FROM backups ORDER BY criado_em DESC LIMIT 50');
      const backups = result.rows.map(r => ({
        id: r.id, tipo: r.tipo, nome: r.nome,
        tamanho: formatSize(Number(r.tamanho)),
        tamanhoBytes: Number(r.tamanho),
        status: r.status,
        data: r.criado_em ? r.criado_em.toISOString() : null
      }));
      res.json(backups);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/status', requireAuth, async (req, res) => {
    try {
      await ensureBackupTable();
      const conf = await pool.query("SELECT valor FROM configuracoes WHERE chave = 'ultimo_backup'");
      const ultimoBackup = conf.rows.length ? conf.rows[0].valor : null;
      const frequencia = 7;
      let proximoBackup = null;
      if (ultimoBackup && ultimoBackup.data) {
        const last = new Date(ultimoBackup.data);
        proximoBackup = new Date(last.getTime() + frequencia * 86400000);
      }
      const totalBackups = (await pool.query('SELECT COUNT(*) FROM backups')).rows[0].count;
      res.json({
        ultimoBackup: ultimoBackup ? { nome: ultimoBackup.nome, data: ultimoBackup.data, tamanho: formatSize(ultimoBackup.tamanho || 0), status: ultimoBackup.status } : null,
        proximoBackup: proximoBackup ? proximoBackup.toISOString() : null,
        frequenciaDias: frequencia,
        totalBackups: Number(totalBackups),
        status: 'ativo'
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/restore/:id', requireAuth, async (req, res) => {
    let client = null;
    try {
      await ensureBackupTable();
      const { id } = req.params;
      const { confirmar } = req.body;

      if (!confirmar) {
        return res.status(400).json({ error: 'Confirmacao necessaria. Envie confirmar: true' });
      }

      console.log('Criando backup de seguranca antes da restauracao...');
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`;
      const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      const safetyName = `BACKUP_SEGURANCA_${dateStr}_${timeStr}`;

      const [dbData, sysData] = await Promise.all([dumpDatabase(), dumpSystemFiles()]);
      const dados = { database: dbData, sistema: sysData, data: now.toISOString() };
      const tamanho = Buffer.byteLength(JSON.stringify(dados), 'utf8');
      await pool.query(
        `INSERT INTO backups (tipo, nome, dados, tamanho, status) VALUES ('seguranca', $1, $2, $3, 'concluido')`,
        [safetyName, dados, tamanho]
      );
      console.log(`Backup de seguranca criado: ${safetyName}`);

      const backup = await pool.query('SELECT dados, nome FROM backups WHERE id = $1', [id]);
      if (!backup.rows.length) {
        return res.status(404).json({ error: 'Backup nao encontrado. ID: ' + id });
      }

      const dadosRestore = backup.rows[0].dados;
      const backupName = backup.rows[0].nome || 'desconhecido';

      if (!dadosRestore || typeof dadosRestore !== 'object') {
        return res.status(400).json({ error: 'Formato de backup invalido: dados corrompidos ou ausentes.' });
      }

      if (!dadosRestore.database || typeof dadosRestore.database !== 'object') {
        return res.status(400).json({ error: 'Formato de backup incompativel: secao "database" ausente. Este backup pode ter sido criado por uma versao anterior.' });
      }

      const criticalTables = ['produtos', 'movimentacoes'];
      const missingTables = criticalTables.filter(t => !dadosRestore.database[t]);
      if (missingTables.length > 0) {
        return res.status(400).json({ error: 'Backup incompleto. Tabelas obrigatorias ausentes: ' + missingTables.join(', ') });
      }

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const produtos = dadosRestore.database.produtos || [];
      for (const row of produtos) {
        if (row.id && !uuidRegex.test(row.id)) {
          return res.status(400).json({ error: 'UUID invalido na tabela produtos. Backup pode ter sido corrompido ou gerado por versao incompativel.' });
        }
      }

      const lotesData = dadosRestore.database.lotes || [];
      for (const lote of lotesData) {
        if (lote.validade && isNaN(new Date(lote.validade).getTime())) {
          return res.status(400).json({ error: 'Data de validade invalida no lote "' + (lote.numero_lote || 'desconhecido') + '"' });
        }
      }

      console.log('Backup validado. Restaurando: ' + backupName);

      client = await pool.connect();

      try {
        await client.query('BEGIN');

  const validTables = new Set([
    'usuarios', 'produtos', 'medicamentos', 'materiais', 'estoques', 'lotes',
    'entradas', 'entrada_itens', 'saidas', 'saida_itens',
    'movimentacoes', 'ajustes_estoque', 'importacoes_movimentacoes',
    'fornecedores', 'configuracoes', 'logs_auditoria'
  ]);
  const restoreOrder = [...validTables];

        for (const table of restoreOrder) {
          const tableData = dadosRestore.database[table];
          if (!tableData || !Array.isArray(tableData)) continue;
          if (!validTables.has(table)) continue;

          await client.query(`TRUNCATE "${table}" CASCADE`);
          if (tableData.length === 0) continue;

          const cols = Object.keys(tableData[0]);
          const batch = 50;
          for (let i = 0; i < tableData.length; i += batch) {
            const chunk = tableData.slice(i, i + batch);
            const values = [];
            const params = [];
            let pi = 1;
            for (const row of chunk) {
              const placeholders = cols.map(c => {
                params.push(row[c] !== undefined ? row[c] : null);
                return `$${pi++}`;
              });
              values.push(`(${placeholders.join(',')})`);
            }
            await client.query(
              `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')}`,
              params
            );
          }
          console.log(`  Tabela ${table}: ${tableData.length} registros restaurados`);
        }

        const verifyProdutos = await client.query('SELECT COUNT(*) FROM produtos');
        const verifyMovs = await client.query('SELECT COUNT(*) FROM movimentacoes');
        const verifyLotes = await client.query('SELECT COUNT(*) FROM lotes');

        const restoredProdutos = Number(verifyProdutos.rows[0].count);
        const restoredMovs = Number(verifyMovs.rows[0].count);
        const restoredLotes = Number(verifyLotes.rows[0].count);

        console.log(`Verificacao: ${restoredProdutos} produtos, ${restoredMovs} movimentacoes, ${restoredLotes} lotes`);

        await client.query('COMMIT');
        console.log(`Restauracao concluida: ${backupName}`);

        res.json({
          ok: true,
          mensagem: 'Restauracao concluida com sucesso',
          backupSeguranca: safetyName,
          backupRestaurado: backupName,
          restaurados: { produtos: restoredProdutos, movimentacoes: restoredMovs, lotes: restoredLotes }
        });
      } catch (restoreErr) {
        await client.query('ROLLBACK');
        console.error('ROLLBACK executado:', restoreErr.message);

        if (restoreErr.message.includes('foreign key')) {
          return res.status(500).json({ error: 'Erro de integridade referencial. Dados do backup podem conter referencias inconsistentes.' });
        }
        if (restoreErr.message.includes('duplicate key')) {
          return res.status(500).json({ error: 'Conflito de dados durante restauracao. Chaves duplicadas detectadas.' });
        }
        if (restoreErr.message.includes('invalid input syntax')) {
          return res.status(500).json({ error: 'Formato de dado invalido. Backup contem dados incompativeis com o banco atual.' });
        }
        throw restoreErr;
      } finally {
        if (client) client.release();
      }
    } catch (err) {
      console.error('Erro na restauracao:', err.message);
      res.status(500).json({ error: 'Erro na restauracao: ' + err.message });
    }
  });

  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM backups WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function checkAutoBackup() {
    try {
      await ensureBackupTable();
      const conf = await pool.query("SELECT valor FROM configuracoes WHERE chave = 'ultimo_backup'");
      const ultimo = conf.rows.length ? conf.rows[0].valor : null;
      const frequencia = 7;
      if (ultimo && ultimo.data) {
        const last = new Date(ultimo.data);
        const diff = (Date.now() - last.getTime()) / 86400000;
        if (diff < frequencia) return;
      }
      console.log('Backup automatico disparado');
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`;
      const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      const nome = `BACKUP_AUTO_${dateStr}_${timeStr}`;
      const [dbData, sysData] = await Promise.all([dumpDatabase(), dumpSystemFiles()]);
      const dados = { database: dbData, sistema: sysData, data: now.toISOString() };
      const dadosJSON = JSON.stringify(dados);
      const tamanho = Buffer.byteLength(dadosJSON, 'utf8');
      await pool.query(
        `INSERT INTO backups (tipo, nome, dados, tamanho, status) VALUES ('automatico', $1, $2, $3, 'concluido')`,
        [nome, dados, tamanho]
      );
      await pool.query(
        `INSERT INTO configuracoes (chave, valor, updated_at) VALUES ('ultimo_backup', $1, NOW()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW()`,
        [JSON.stringify({ data: now.toISOString(), nome, tamanho, status: 'concluido' })]
      );
      console.log(`Backup automatico concluido: ${nome} (${(tamanho/1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error('Erro no backup automatico:', err.message);
    }
  }

  setInterval(checkAutoBackup, 3600000);
  setTimeout(checkAutoBackup, 30000);

  return router;
};
