// Importa recursos principais do Baileys para autenticação, conexão e controle de reconexão.
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
// Importa o client do Supabase para atualizar status/QR da instância no backend.
const { createClient } = require('@supabase/supabase-js');
// Importa utilitário de filesystem para garantir diretório de sessão em /data.
const fs = require('node:fs');
// Importa utilitário de path para montar caminhos portáveis.
const path = require('node:path');

// Define variáveis obrigatórias para inicialização do worker (INSTANCE_ID tem fallback padrão).
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
// Filtra variáveis ausentes para erro claro de configuração.
const missingEnvVars = requiredEnvVars.filter((envName) => !process.env[envName]);

// Encerra o processo caso configuração mínima não esteja presente.
if (missingEnvVars.length > 0) {
  console.error(
    `[worker] variáveis ausentes: ${missingEnvVars.join(', ')}`
  );
  process.exit(1);
}

// Define o identificador da instância com fallback seguro para "default".
const instanceId = process.env.INSTANCE_ID || 'default';
// Cria cliente Supabase no backend usando service role (nunca expor no frontend).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Atualiza parcialmente a row da instância no Supabase para refletir estado atual.
async function updateInstance(patch) {
  const { error } = await supabase
    .from('instances')
    .update(patch)
    .eq('id', instanceId);

  if (error) {
    // Log curto e sem payloads completos para evitar vazamento de dados.
    console.error(`[worker] falha ao atualizar instância: ${error.message}`);
  }
}

// Garante que a row da instância existe antes de iniciar o socket do WhatsApp.
async function ensureInstanceRow() {
  const { data, error } = await supabase
    .from('instances')
    .select('id')
    .eq('id', instanceId)
    .maybeSingle();

  if (error) {
    throw new Error(`erro ao consultar instância: ${error.message}`);
  }

  if (!data) {
    const { error: insertError } = await supabase.from('instances').insert({
      id: instanceId,
      name: `Worker ${instanceId}`,
      status: 'DISCONNECTED',
      qr_code: null,
    });

    if (insertError) {
      throw new Error(`erro ao criar instância: ${insertError.message}`);
    }
  }
}

// Converte motivo de desconexão para mensagem curta e segura de log.
function getDisconnectReason(update) {
  const statusCode = update?.lastDisconnect?.error?.output?.statusCode;

  if (typeof statusCode === 'number') {
    if (statusCode === DisconnectReason.loggedOut) {
      return 'loggedOut';
    }

    return `code:${statusCode}`;
  }

  return 'indefinido';
}

// Inicializa conexão Baileys e registra handlers de lifecycle (QR/open/close).
async function startSocket() {
  // Monta e garante a pasta de sessão persistente em /data/<INSTANCE_ID>.
  const sessionDir = path.join('/data', instanceId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Carrega/salva credenciais da sessão de forma persistente em múltiplos arquivos.
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  // Obtém versão mais recente suportada do WhatsApp Web.
  const { version } = await fetchLatestBaileysVersion();

  // Cria socket WhatsApp com auth persistida e log interno reduzido.
  const socket = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
  });

  // Persiste credenciais sempre que houver atualização de auth.
  socket.ev.on('creds.update', saveCreds);

  // Reage a mudanças de conexão para publicar status e QR no Supabase.
  socket.ev.on('connection.update', async (update) => {
    // Quando o QR é gerado, salva no banco para consumo externo (sem logar conteúdo completo).
    if (update.qr) {
      console.log('[worker] qr gerado');
      await updateInstance({
        status: 'CONNECTING',
        qr_code: update.qr,
      });
    }

    // Quando conexão abre, marca como conectada e limpa QR.
    if (update.connection === 'open') {
      console.log('[worker] conectado');
      await updateInstance({
        status: 'CONNECTED',
        qr_code: null,
      });
    }

    // Quando conexão fecha, marca desconectado e reconecta automaticamente (exceto loggedOut).
    if (update.connection === 'close') {
      const reason = getDisconnectReason(update);
      console.log(`[worker] desconectado motivo=${reason}`);

      await updateInstance({
        status: 'DISCONNECTED',
      });

      const isLoggedOut =
        update?.lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (!isLoggedOut) {
        // Tenta reiniciar socket para reconectar automaticamente.
        setTimeout(() => {
          startSocket().catch((error) => {
            console.error(`[worker] erro na reconexão: ${error.message}`);
          });
        }, 2_000);
      }
    }
  });
}

// Bootstrap principal do worker.
async function main() {
  console.log('[worker] iniciando');
  console.log('[worker] conectando supabase');

  await ensureInstanceRow();
  await startSocket();
}

// Executa o worker e encerra com código de erro em falhas fatais de bootstrap.
main().catch((error) => {
  console.error(`[worker] erro fatal: ${error.message}`);
  process.exit(1);
});
