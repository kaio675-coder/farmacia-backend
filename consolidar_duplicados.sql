-- =========================================================
-- SCRIPT DE CONSOLIDAÇÃO DE PRODUTOS DUPLICADOS
-- Execute uma vez para limpar duplicados existentes
-- =========================================================

-- 1. Identificar grupos de duplicados (mesmo nome normalizado + tipo)
WITH dup_groups AS (
  SELECT
    UPPER(TRIM(nome)) AS nome_norm,
    tipo,
    ARRAY_AGG(id ORDER BY created_at ASC) AS ids,
    COUNT(*) AS qtd
  FROM produtos
  WHERE ativo = TRUE
  GROUP BY nome_norm, tipo
  HAVING COUNT(*) > 1
),
-- 2. Para cada grupo, escolher o "mestre" (mais antigo) e os "duplicados"
mestres AS (
  SELECT
    nome_norm,
    tipo,
    ids[1] AS mestre_id,
    ids[2:] AS duplicado_ids
  FROM dup_groups
)

-- 3. Mover lotes dos duplicados para o mestre
UPDATE lotes l
SET produto_id = m.mestre_id
FROM mestres m
WHERE l.produto_id = ANY(m.duplicado_ids)
  AND NOT EXISTS (
    SELECT 1 FROM lotes l2
    WHERE l2.produto_id = m.mestre_id
      AND l2.numero_lote = l.numero_lote
  );

-- 4. Mover lotes duplicados (mesmo lote no mestre) - somar quantidade
UPDATE lotes l
SET quantidade = l.quantidade + l2.quantidade
FROM lotes l2
WHERE l.produto_id IN (SELECT mestre_id FROM mestres)
  AND l2.produto_id IN (SELECT UNNEST(duplicado_ids) FROM mestres)
  AND l.numero_lote = l2.numero_lote
  AND l.id != l2.id;

-- 5. Remover lotes órfãos dos duplicados (que já foram movidos ou são duplicados)
DELETE FROM lotes
WHERE produto_id IN (SELECT UNNEST(duplicado_ids) FROM mestres);

-- 6. Mover movimentações dos duplicados para o mestre
UPDATE movimentacoes
SET produto_id = (SELECT mestre_id FROM mestres m WHERE m.duplicado_ids @> ARRAY[movimentacoes.produto_id])
WHERE produto_id IN (SELECT UNNEST(duplicado_ids) FROM mestres);

-- 7. Mover dados de medicamentos/materiais
UPDATE medicamentos m
SET produto_id = mt.mestre_id
FROM mestres mt
WHERE m.produto_id = ANY(mt.duplicado_ids)
  AND NOT EXISTS (SELECT 1 FROM medicamentos m2 WHERE m2.produto_id = mt.mestre_id);

UPDATE materiais m
SET produto_id = mt.mestre_id
FROM mestres mt
WHERE m.produto_id = ANY(mt.duplicado_ids)
  AND NOT EXISTS (SELECT 1 FROM materiais m2 WHERE m2.produto_id = mt.mestre_id);

-- 8. Consolidar estoques: somar quantities e manter apenas 1 registro
UPDATE estoques e
SET quantidade_atual = (
  SELECT COALESCE(SUM(e2.quantidade_atual), 0)
  FROM estoques e2
  WHERE e2.produto_id IN (SELECT mestre_id FROM mestres)
     OR e2.produto_id IN (SELECT UNNEST(duplicado_ids) FROM mestres)
)
WHERE e.produto_id IN (SELECT mestre_id FROM mestres);

DELETE FROM estoques
WHERE produto_id IN (SELECT UNNEST(duplicado_ids) FROM mestres);

-- 9. Marcar duplicados como inativos
UPDATE produtos
SET ativo = FALSE, updated_at = NOW()
WHERE id IN (SELECT UNNEST(duplicado_ids) FROM mestres);

-- 10. Limpar lotes órfãos (produto_id que não existe em produtos)
DELETE FROM lotes
WHERE produto_id NOT IN (SELECT id FROM produtos);

-- 11. Limpar estoques órfãos
DELETE FROM estoques
WHERE produto_id NOT IN (SELECT id FROM produtos);

-- 12. Limpar movimentações órfãs
DELETE FROM movimentacoes
WHERE produto_id NOT IN (SELECT id FROM produtos);

-- =========================================================
-- VERIFICAÇÃO PÓS-CONSOLIDAÇÃO
-- =========================================================
SELECT 'Produtos ativos' AS item, COUNT(*) AS qtd FROM produtos WHERE ativo = TRUE
UNION ALL
SELECT 'Duplicados restantes', COUNT(*) FROM (
  SELECT UPPER(TRIM(nome)) AS n, tipo FROM produtos WHERE ativo = TRUE
  GROUP BY n, tipo HAVING COUNT(*) > 1
) d
UNION ALL
SELECT 'Lotes', COUNT(*) FROM lotes
UNION ALL
SELECT 'Estoques', COUNT(*) FROM estoques
UNION ALL
SELECT 'Movimentacoes', COUNT(*) FROM movimentacoes;
