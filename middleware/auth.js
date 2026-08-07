const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('CRITICO: JWT_SECRET nao configurado. Defina a variavel de ambiente JWT_SECRET.');
}
const EFFECTIVE_SECRET = JWT_SECRET || 'fallback-not-for-production';
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
    const decoded = jwt.verify(token, EFFECTIVE_SECRET);
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

module.exports = { requireAuth, requireRole, requireImportPermission, JWT_SECRET: EFFECTIVE_SECRET, JWT_EXPIRES };
