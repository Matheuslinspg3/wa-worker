# wa-worker

Worker de WhatsApp (Baileys) com suporte **multi-instância**, persistência local de sessão em volume e integração via **Edge Functions proxy**.

## Arquitetura

Este worker **não usa Supabase Service Role diretamente**. Em vez disso, ele faz chamadas HTTP para um proxy em Edge Functions usando `WORKER_SECRET`.

O worker é **multi-instância**: ele descobre automaticamente quais instâncias precisam ser conectadas fazendo polling em `GET /disconnected-instances` a cada `INSTANCE_POLL_MS` milissegundos. Cada instância roda em paralelo no mesmo processo Node.

### Fluxo

```
Início
  └─ GET /disconnected-instances          → lista instanceIds com status DISCONNECTED | CONNECTING
       └─ connectInstance(id)             → cria socket Baileys isolado por instanceId
            ├─ QR gerado → POST /update-status  { status: "CONNECTING", qr_code: "<dataUrl>" }
            ├─ Conectou  → POST /update-status  { status: "CONNECTED",  qr_code: null }
            └─ Fechou    → POST /update-status  { status: "DISCONNECTED" } + agenda reconexão
```

## Variáveis de ambiente

| Variável           | Obrigatória | Default         | Descrição |
|--------------------|-------------|-----------------|-----------|
| `EDGE_BASE_URL`    | ✅          | —               | URL base do worker-proxy. Ex: `https://<project>.supabase.co/functions/v1/worker-proxy` |
| `WORKER_SECRET`    | ✅          | —               | Enviado no header `Authorization: Bearer <secret>` |
| `PORT`             | ❌          | `3000`          | Porta do servidor HTTP (healthcheck) |
| `AUTH_DIR`         | ❌          | `/data/auth`    | Diretório raiz para sessões Baileys. Cada instância usa `<AUTH_DIR>/<instanceId>` |
| `INSTANCE_POLL_MS` | ❌          | `10000`         | Intervalo (ms) para buscar novas instâncias desconectadas |
| `MSG_POLL_MS`      | ❌          | `2000`          | Intervalo (ms) para poll de mensagens enfileiradas por instância |

## Endpoints consumidos (Edge Function)

Com base no `EDGE_BASE_URL`:

| Método | Path | Descrição |
|--------|------|-----------|
| `GET`  | `/disconnected-instances` | **Novo** — retorna `[{ id: string }, ...]` com instâncias onde `status IN ('DISCONNECTED', 'CONNECTING')` |
| `POST` | `/update-status` | Atualiza `status` e `qr_code` de uma instância |
| `GET`  | `/queued-messages?instanceId=<id>` | Busca mensagens pendentes de envio |
| `POST` | `/mark-sent` | Marca mensagem como enviada |
| `POST` | `/inbound` | Registra mensagem recebida |

### Endpoint novo que o worker-proxy precisa implementar

```typescript
// GET /disconnected-instances
// Retorna instâncias que o worker precisa conectar
if (path === '/disconnected-instances' && req.method === 'GET') {
  const { data, error } = await supabase
    .from('instances')
    .select('id')
    .in('status', ['DISCONNECTED', 'CONNECTING'])

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  return new Response(JSON.stringify(data), { status: 200 })
}
```

## Persistência de sessão

A sessão do Baileys é salva em:

```
<AUTH_DIR>/<instanceId>/
```

Em deploy, monte um volume persistente em `/data` (o default de `AUTH_DIR` é `/data/auth`).

## Configuração no Easypanel

1. **Build/Runtime**: Dockerfile deste repositório
2. **Command**: `node index.js`
3. **Environment variables**:
   - `EDGE_BASE_URL`
   - `WORKER_SECRET`
   - `PORT` (default `3000`)
4. **Persistent volume**:
   - Mount path: `/data`
5. **Porta (healthcheck)**:
   - Adicione a porta `3000` no Easypanel
   - Health path: `/health` ou `/`

> Não configure `SUPABASE_SERVICE_ROLE_KEY` neste worker. A credencial fica apenas no backend/proxy.

## Healthcheck

`GET /` ou `GET /health` retorna:

```json
{
  "status": "ok",
  "instances": {
    "connected": 2,
    "connecting": 1,
    "reconnecting": 0
  }
}
```

## Execução local

```bash
EDGE_BASE_URL=https://... WORKER_SECRET=... node index.js
```
