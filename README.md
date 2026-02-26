# wa-worker

Worker de WhatsApp (Baileys) com suporte a **multi-instância**, persistência local de sessão por instância e integração via **Edge Functions proxy**.

## Arquitetura

Este worker **não usa Supabase Service Role diretamente**. Em vez disso, ele faz chamadas HTTP para um proxy em Edge Functions usando `WORKER_SECRET`.

Cada ciclo de descoberta (a cada 10s):

1. Busca configurações do backend:
   - `GET /worker-settings` → `{ max_active_instances }`
2. Busca candidatas para conexão:
   - `GET /disconnected-instances?limit=50` → `{ instances:[{ id, priority }] }`
3. Ordena por `priority` desc e mantém conectadas apenas as TOP N (`N = max_active_instances`).

## Variáveis de ambiente

- `EDGE_BASE_URL` (obrigatória)
  - Ex: `https://<project>.supabase.co/functions/v1/worker-proxy`
- `WORKER_SECRET` (obrigatória)
  - Enviada no header: `Authorization: Bearer <WORKER_SECRET>`
- `PORT` (opcional)
  - Default: `3000`

> `INSTANCE_ID` **não é mais usado**.

## Persistência de sessão (obrigatória)

A autenticação do Baileys é salva por instância em:

- `/data/auth/<instanceId>`

Em deploy, monte um volume persistente em `/data`.

## Endpoints consumidos

Com base no `EDGE_BASE_URL`:

- `GET /worker-settings`
- `GET /disconnected-instances?limit=50`
- `POST /update-status`
- `GET /queued-messages?instanceId=<instanceId>`
- `POST /mark-sent`
- `POST /inbound`

## Health server

- Bind: `0.0.0.0`
- Porta: `PORT` (default `3000`)
- Endpoint: `GET /health` → `ok`

## Fluxo de status por instância

- QR disponível:
  - `POST /update-status` com `{ instanceId, status:"CONNECTING", qr_code:<dataURL> }`
- Conectada:
  - `POST /update-status` com `{ instanceId, status:"CONNECTED", qr_code:null }`
- Desconectada:
  - `POST /update-status` com `{ instanceId, status:"DISCONNECTED", qr_code:null }`

## Outbound por instância conectada

Cada instância conectada faz polling da fila:

1. `GET /queued-messages?instanceId=...`
2. Envia mensagem via `sock.sendMessage`
3. Confirma com `POST /mark-sent`

## Configuração no Easypanel

1. **Build/Runtime**: Node.js (ou Dockerfile deste repositório)
2. **Command**: `node index.js`
3. **Environment variables**:
   - `EDGE_BASE_URL`
   - `WORKER_SECRET`
   - `PORT` (opcional)
4. **Persistent volume obrigatório**:
   - Mount path: `/data`
5. **Porta (healthcheck)**:
   - Adicione a porta `3000` (ou a definida em `PORT`)

> Não configure `SUPABASE_SERVICE_ROLE_KEY` neste worker. A credencial fica apenas no backend/proxy.

## Execução local

```bash
node index.js
```
