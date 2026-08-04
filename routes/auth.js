const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, JWT_EXPIRES, requireAuth } = require('../middleware/auth');

module.exports = function(pool) {
  const router = express.Router();

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    try {
      const { usuario, senha } = req.body;
      if (!usuario || !senha) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
      }

      // Buscar por email ou usuario
      const result = await pool.query(
        `SELECT * FROM usuarios WHERE (email = $1 OR usuario = $1 OR nome = $1) AND ativo = TRUE`,
        [usuario]
      );

      if (!result.rows.length) {
        return res.status(401).json({ error: 'Usuário ou senha incorretos' });
      }

      const user = result.rows[0];

      // Verificar senha
      let senhaValida = false;
      // Verificar se é hash bcrypt (começa com $2a$, $2b$, etc.)
      if (user.senha_hash && user.senha_hash.startsWith('$2')) {
        senhaValida = await bcrypt.compare(senha, user.senha_hash);
      } else {
        // Senha em texto plano (compatibilidade com admin existente)
        senhaValida = (senha === user.senha_hash);
        // Rehashear com bcrypt se a senha estiver correta
        if (senhaValida) {
          const hash = await bcrypt.hash(senha, 10);
          await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, user.id]);
        }
      }

      if (!senhaValida) {
        return res.status(401).json({ error: 'Usuário ou senha incorretos' });
      }

      // Atualizar último login
      await pool.query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1', [user.id]);

      // Gerar token JWT
      const token = jwt.sign(
        {
          id: user.id,
          nome: user.nome,
          email: user.email,
          usuario: user.usuario,
          perfil: user.perfil
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES }
      );

      // Setar cookie HTTP-only
      const isProduction = process.env.RAILWAY_ENVIRONMENT === 'production' || process.env.NODE_ENV === 'production';
      res.cookie('token', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 horas
      });

      res.json({
        ok: true,
        token: token,
        user: {
          id: user.id,
          nome: user.nome,
          email: user.email,
          usuario: user.usuario,
          perfil: user.perfil
        }
      });
    } catch (err) {
      console.error('Erro no login:', err.message);
      res.status(500).json({ error: 'Erro interno no servidor' });
    }
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ ok: true });
  });

  // GET /api/auth/me
  router.get('/me', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, nome, email, usuario, perfil, ativo, ultimo_login, created_at FROM usuarios WHERE id = $1',
        [req.user.id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      res.json(result.rows[0]);
    } catch (err) {
      console.error('Erro ao buscar usuário:', err.message);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // POST /api/auth/change-password
  router.post('/change-password', requireAuth, async (req, res) => {
    try {
      const { senhaAtual, novaSenha } = req.body;
      if (!senhaAtual || !novaSenha) {
        return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias' });
      }
      if (novaSenha.length < 6) {
        return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
      }

      const result = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.user.id]);
      if (!result.rows.length) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      const user = result.rows[0];
      let senhaValida = false;
      if (user.senha_hash && user.senha_hash.startsWith('$2')) {
        senhaValida = await bcrypt.compare(senhaAtual, user.senha_hash);
      } else {
        senhaValida = (senhaAtual === user.senha_hash);
      }

      if (!senhaValida) {
        return res.status(401).json({ error: 'Senha atual incorreta' });
      }

      const novoHash = await bcrypt.hash(novaSenha, 10);
      await pool.query('UPDATE usuarios SET senha_hash = $1, atualizado_em = NOW() WHERE id = $2', [novoHash, req.user.id]);

      res.json({ ok: true, message: 'Senha alterada com sucesso' });
    } catch (err) {
      console.error('Erro ao alterar senha:', err.message);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  return router;
};
