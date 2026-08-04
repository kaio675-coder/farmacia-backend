const express = require('express');
const { requireAuth, requireImportPermission } = require('../middleware/auth');

module.exports = function(pool) {
  const router = express.Router();

  // POST /api/movimentacoes/importar - Importar movimentações de Excel/CSV
  router.post('/importar', requireAuth, requireImportPermission, async (req, res) => {
    const client = await pool.connect();
    try {
      const { movimentacoes, nomeArquivo } = req.body;

      if (!Array.isArray(movimentacoes) || movimentacoes.length === 0) {
        return res.status(400).json({ error: 'Nenhuma movimentação para importar' });
      }

      await client.query('BEGIN');

      let importados = 0;
      let ignorados = 0;
      let comErro = 0;
      const erros = [];

      for (let i = 0; i < movimentacoes.length; i++) {
        const mov = movimentacoes[i];
        const linha = i + 1;

        try {
          // Validar dados obrigatórios
          if (!mov.produto_id) {
            erros.push({ linha, produto: mov.produto || 'N/A', erro: 'Produto não encontrado' });
            comErro++;
            continue;
          }

          if (!mov.quantidade || Number(mov.quantidade) <= 0) {
            erros.push({ linha, produto: mov.produto || 'N/A', erro: 'Quantidade inválida' });
            comErro++;
            continue;
          }

          if (!mov.data) {
            erros.push({ linha, produto: mov.produto || 'N/A', erro: 'Data inválida' });
            comErro++;
            continue;
          }

          const tipoNormalizado = normalizarTipo(mov.tipo);
          if (!tipoNormalizado) {
            erros.push({ linha, produto: mov.produto || 'N/A', erro: 'Tipo de movimentação inválido' });
            comErro++;
            continue;
          }

          // Buscar estoque atual
          const estoqueResult = await client.query(
            'SELECT quantidade_atual FROM estoques WHERE produto_id = $1',
            [mov.produto_id]
          );
          const estoqueAtual = estoqueResult.rows.length ? Number(estoqueResult.rows[0].quantidade_atual) : 0;

          let estoquePosterior;
          if (tipoNormalizado === 'entrada') {
            estoquePosterior = estoqueAtual + Number(mov.quantidade);
          } else if (tipoNormalizado === 'saida') {
            estoquePosterior = estoqueAtual - Number(mov.quantidade);
            if (estoquePosterior < 0) {
              erros.push({ linha, produto: mov.produto || 'N/A', erro: 'Estoque insuficiente' });
              comErro++;
              continue;
            }
          } else {
            estoquePosterior = Number(mov.estoquePosterior || mov.quantidade);
          }

          // Inserir movimentação
          const dataMov = mov.data ? new Date(mov.data + 'T12:00:00Z') : new Date();
          await client.query(
            `INSERT INTO movimentacoes (produto_id, tipo, quantidade, estoque_anterior, estoque_posterior, data, observacao, responsavel_id, origem)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              mov.produto_id,
              tipoNormalizado,
              mov.quantidade,
              estoqueAtual,
              estoquePosterior,
              dataMov,
              mov.observacao || mov.motivo || '',
              req.user.id,
              'importacao'
            ]
          );

          // Atualizar estoque
          await client.query(
            'UPDATE estoques SET quantidade_atual = $1, updated_at = NOW() WHERE produto_id = $2',
            [estoquePosterior, mov.produto_id]
          );

          importados++;
        } catch (err) {
          erros.push({ linha, produto: mov.produto || 'N/A', erro: err.message });
          comErro++;
        }
      }

      // Registrar histórico de importação
      await client.query(
        `INSERT INTO importacoes_movimentacoes (nome_arquivo, usuario_id, total_registros, registros_importados, registros_ignorados, registros_com_erro, observacoes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          nomeArquivo || 'desconhecido',
          req.user.id,
          movimentacoes.length,
          importados,
          ignorados,
          comErro,
          erros.length > 0 ? JSON.stringify(erros.slice(0, 50)) : null
        ]
      );

      // Registrar auditoria
      await client.query(
        `INSERT INTO logs_auditoria (usuario_id, acao, tabela, dados_novos)
         VALUES ($1, 'importacao_movimentacoes', 'movimentacoes', $2)`,
        [req.user.id, JSON.stringify({
          arquivo: nomeArquivo,
          total: movimentacoes.length,
          importados,
          ignorados,
          comErro
        })]
      );

      await client.query('COMMIT');

      res.json({
        ok: true,
        total: movimentacoes.length,
        importados,
        ignorados,
        comErro,
        erros: erros.slice(0, 100)
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Erro na importação:', err.message);
      res.status(500).json({ error: 'Erro durante a importação: ' + err.message });
    } finally {
      client.release();
    }
  });

  // GET /api/movimentacoes/importacoes - Histórico de importações
  router.get('/importacoes', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT i.*, u.nome AS usuario_nome
         FROM importacoes_movimentacoes i
         LEFT JOIN usuarios u ON u.id = i.usuario_id
         ORDER BY i.data_importacao DESC
         LIMIT 50`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Erro ao listar importações:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// Helper: normalizar tipo de movimentação
function normalizarTipo(tipo) {
  if (!tipo) return null;
  const t = tipo.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const entradas = ['entrada', 'compra', 'recebimento', 'devolucao', 'devolucao de paciente'];
  if (entradas.some(e => t.includes(e))) return 'entrada';

  const saidas = ['saida', 'saída', 'dispensa', 'dispensacao', 'consumo', 'perda'];
  if (saidas.some(s => t.includes(s))) return 'saida';

  const ajustes = ['ajuste', 'correcao', 'acerto', 'ajuste de estoque'];
  if (ajustes.some(a => t.includes(a))) return 'ajuste';

  return null;
}
