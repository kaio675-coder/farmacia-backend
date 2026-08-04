-- =========================================================
-- MIGRATION 001: ADICIONAR AUTENTICAÇÃO E IMPORTAÇÃO
-- =========================================================

-- 1. Estender tabela usuarios
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS usuario VARCHAR(100) UNIQUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_login TIMESTAMPTZ;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ DEFAULT NOW();

-- 2. Criar tabela de histórico de importações
CREATE TABLE IF NOT EXISTS importacoes_movimentacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_arquivo VARCHAR(255),
    usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
    data_importacao TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_registros INT NOT NULL DEFAULT 0,
    registros_importados INT NOT NULL DEFAULT 0,
    registros_ignorados INT NOT NULL DEFAULT 0,
    registros_com_erro INT NOT NULL DEFAULT 0,
    observacoes TEXT
);

-- 3. Atualizar admin existente: definir usuario e rehashear senha
-- Senha original: admin123 (hash bcrypt gerado via bcryptjs)
-- O backend tambem suporta fallback para texto plano e rehasheia automaticamente
UPDATE usuarios
SET usuario = 'admin',
    atualizado_em = NOW()
WHERE email = 'admin@farmaciaplus.com';
