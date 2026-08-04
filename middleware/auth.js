const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'farmacia-plus-secret-key-2026';
const JWT_EXPIRES = '24h';

// Middleware: exige autenticação
function requireAuth(req, res, next) {
  let token = req.cookies && req.cookies.token;
  if (!token) {
    const authHeader = req.headers && req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão expirada' });
  }
}

// Middleware: exige perfil específico
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    if (!roles.includes(req.user.perfil)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    next();
  };
}

// Middleware: exige permissão de importação
function requireImportPermission(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  if (req.user.perfil === 'administrador') {
    return next();
  }
  if (req.user.permissao_importar) {
    return next();
  }
  return res.status(403).json({ error: 'Sem permissão para importar movimentações' });
}

module.exports = { requireAuth, requireRole, requireImportPermission, JWT_SECRET, JWT_EXPIRES };
