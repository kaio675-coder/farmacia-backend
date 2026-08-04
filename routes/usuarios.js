const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware/auth');

module.exports = function(pool) {
  const router = express.Router();

  // Todas as rotas requerem auth + admin
  router.use(requireAuth);
  router.use(requireRole('administrador'));

  // GET /api/usuarios - Lista todos
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, nome, email, usuario, perfil, ativo, ultimo_login, created_at, atualizado_em
         FROM usuarios ORDER BY nome`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Erro ao listar usuários:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/usuarios - Cria usuário
  router.post('/', async (req, res) => {
    try {
      const { nome, email, usuario, senha, perfil, ativo } = req.body;
      if (!nome || !senha) {
        return res.status(400).json({ error: 'Nome e senha são obrigatórios' });
      }
      if (senha.length < 6) {
        return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
      }

      const perfilValido = ['administrador', 'gestor', 'operador', 'consulta'];
      const perfilFinal = perfilValido.includes(perfil) ? perfil : 'operador';

      const hash = await bcrypt.hash(senha, 10);

      const result = await pool.query(
        `INSERT INTO usuarios (nome, email, usuario, senha_hash, perfil, ativo)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, nome, email, usuario, perfil, ativo, created_at`,
        [nome, email || null, usuario || null, hash, perfilFinal, ativo !== false]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(400).json({ error: 'Email ou usuário já existente' });
      }
      console.error('Erro ao criar usuário:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/usuarios/:id - Editar usuário
  router.put('/:id', async (req, res) => {
    try {
      const { nome, email, usuario, perfil, ativo, senha } = req.body;
      const id = req.params.id;

      const perfilValido = ['administrador', 'gestor', 'operador', 'consulta'];
      const perfilFinal = perfilValido.includes(perfil) ? perfil : 'operador';

      if (senha) {
        const hash = await bcrypt.hash(senha, 10);
        await pool.query(
          `UPDATE usuarios SET nome=$1, email=$2, usuario=$3, perfil=$4, ativo=$5, senha_hash=$6, atualizado_em=NOW()
           WHERE id=$7`,
          [nome, email || null, usuario || null, perfilFinal, ativo !== false, hash, id]
        );
      } else {
        await pool.query(
          `UPDATE usuarios SET nome=$1, email=$2, usuario=$3, perfil=$4, ativo=$5, atualizado_em=NOW()
           WHERE id=$6`,
          [nome, email || null, usuario || null, perfilFinal, ativo !== false, id]
        );
      }

      const result = await pool.query(
        `SELECT id, nome, email, usuario, perfil, ativo, created_at, atualizado_em
         FROM usuarios WHERE id=$1`, [id]
      );

      res.json(result.rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(400).json({ error: 'Email ou usuário já existente' });
      }
      console.error('Erro ao editar usuário:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/usuarios/:id - Desativar usuário
  router.delete('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      // Não permitir desativar a si mesmo
      if (id === req.user.id) {
        return res.status(400).json({ error: 'Você não pode desativar seu próprio usuário' });
      }
      await pool.query('UPDATE usuarios SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('Erro ao desativar usuário:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/usuarios/:id/reset-password - Redefinir senha
  router.post('/:id/reset-password', async (req, res) => {
    try {
      const { novaSenha } = req.body;
      if (!novaSenha || novaSenha.length < 6) {
        return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
      }

      const hash = await bcrypt.hash(novaSenha, 10);
      await pool.query('UPDATE usuarios SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2', [hash, req.params.id]);

      res.json({ ok: true, message: 'Senha redefinida com sucesso' });
    } catch (err) {
      console.error('Erro ao redefinir senha:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
