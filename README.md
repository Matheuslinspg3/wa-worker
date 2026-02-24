# wa-worker

Worker Node.js para conexão com WhatsApp via Baileys e atualização de status/QR no Supabase, pronto para deploy no Easypanel.

## Pré-requisitos

- Node.js 18+
- npm 9+
- Tabela `public.instances` no Supabase (campos usados: `id`, `name`, `status`, `qr_code`)

## Instalação local

1. Instale as dependências:

```bash
npm install
```

2. Defina as variáveis de ambiente (exemplo):

```env
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key
INSTANCE_ID=default
```

> `INSTANCE_ID` é opcional e usa `default` quando não informado.

3. Execute o worker:

```bash
npm start
```

## Comportamento do worker (MVP Fase 2)

- Valida `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` na inicialização.
- Garante existência da row em `instances` para `INSTANCE_ID`.
- Persiste sessão do Baileys em `/data/<INSTANCE_ID>`.
- Atualiza status no Supabase:
  - QR gerado: `CONNECTING` + `qr_code`
  - Conectado: `CONNECTED` + `qr_code = null`
  - Desconectado: `DISCONNECTED`
- Tenta reconectar automaticamente quando desconecta, exceto em caso `loggedOut`.

## Migration auxiliar

Caso a tabela ainda não tenha `qr_code`, use o SQL em `supabase_migration.sql`:

```sql
ALTER TABLE public.instances ADD COLUMN IF NOT EXISTS qr_code text;
```

## Deploy no Easypanel

1. Crie o serviço apontando para este repositório.
2. Faça o deploy com `easypanel deploy` (ou pela interface).
3. Configure as variáveis de ambiente:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `INSTANCE_ID` (opcional)
4. Monte volume persistente em `/data` para sessões do WhatsApp.

## Estrutura do projeto

```text
.
├── .gitignore
├── AGENTS.md
├── Dockerfile
├── README.md
├── index.js
├── package.json
└── supabase_migration.sql
```
