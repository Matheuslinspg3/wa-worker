// Importa o módulo principal do Baileys para confirmar que a dependência está disponível.
const baileys = require('@whiskeysockets/baileys');
// Importa o client do Supabase para validar uso da SDK no worker backend.
const { createClient } = require('@supabase/supabase-js');

// Lista de variáveis obrigatórias para inicialização segura do worker.
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'INSTANCE_ID'];

// Filtra as variáveis ausentes para retornar uma mensagem clara em caso de configuração incompleta.
const missingEnvVars = requiredEnvVars.filter((envName) => !process.env[envName]);

// Interrompe a execução caso alguma variável obrigatória não esteja definida.
if (missingEnvVars.length > 0) {
  console.error(
    `Variáveis de ambiente obrigatórias ausentes: ${missingEnvVars.join(', ')}`
  );
  process.exit(1);
}

// Instancia o cliente do Supabase usando credenciais de backend (service role).
// Observação: o cliente é criado para validar a configuração; integrações reais podem ser adicionadas depois.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Referencia o módulo Baileys e o cliente Supabase para evitar variáveis não utilizadas no template inicial.
void baileys;
void supabase;

// Mensagem mínima exigida para confirmar bootstrap do worker.
console.log('Worker iniciado');
