require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function limparDados() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('=== VERIFICAÇÃO ANTES DA LIMPEZA ===\n');

    const counts = {};
    const tables = ['produtos', 'medicamentos', 'materiais', 'estoques', 'lotes',
                    'entradas', 'entrada_itens', 'saidas', 'saida_itens',
                    'movimentacoes', 'ajustes_estoque', 'importacoes_movimentacoes',
                    'fornecedores', 'logs_auditoria', 'usuarios', 'configuracoes'];

    for (const t of tables) {
      const r = await client.query(`SELECT COUNT(*) FROM ${t}`);
      counts[t] = parseInt(r.rows[0].count);
      console.log(`  ${t}: ${counts[t]} registros`);
    }

    console.log('\n=== INICIANDO LIMPEZA ===\n');

    const deletes = [
      { table: 'saida_itens', desc: 'Itens de saída' },
      { table: 'entrada_itens', desc: 'Itens de entrada' },
      { table: 'saidas', desc: 'Saídas' },
      { table: 'entradas', desc: 'Entradas' },
      { table: 'movimentacoes', desc: 'Movimentações' },
      { table: 'ajustes_estoque', desc: 'Ajustes de estoque' },
      { table: 'importacoes_movimentacoes', desc: 'Importações' },
      { table: 'lotes', desc: 'Lotes' },
      { table: 'estoques', desc: 'Estoques' },
      { table: 'medicamentos', desc: 'Medicamentos (detalhes)' },
      { table: 'materiais', desc: 'Materiais (detalhes)' },
      { table: 'produtos', desc: 'Produtos' },
      { table: 'fornecedores', desc: 'Fornecedores' },
      { table: 'logs_auditoria', desc: 'Logs de auditoria' },
    ];

    for (const d of deletes) {
      const r = await client.query(`DELETE FROM ${d.table}`);
      console.log(`  ✓ ${d.desc}: ${r.rowCount} registros apagados`);
    }

    await client.query('COMMIT');

    console.log('\n=== VERIFICAÇÃO APÓS LIMPEZA ===\n');

    const keep = ['usuarios', 'configuracoes'];
    for (const t of keep) {
      const r = await pool.query(`SELECT COUNT(*) FROM ${t}`);
      console.log(`  ✓ ${t}: ${r.rows[0].count} registros PRESERVADOS`);
    }

    console.log('\n=== LIMPEZA CONCLUÍDA ===\n');
    console.log('Resultado:');
    console.log(`  Medicamentos apagados: ${counts.produtos}`);
    console.log(`  Movimentações apagadas: ${counts.movimentacoes}`);
    console.log(`  Lotes apagados: ${counts.lotes}`);
    console.log(`  Estoque apagado: ${counts.estoques}`);
    console.log(`  Importações apagadas: ${counts.importacoes_movimentacoes}`);
    console.log(`  Usuários preservados: ${counts.usuarios}`);
    console.log(`  Configurações preservadas: ${counts.configuracoes}`);
    console.log('\n  ✅ Sistema pronto para novos cadastros.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ ERRO:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

limparDados();
