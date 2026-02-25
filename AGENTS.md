# Regras de codificação do projeto

- Não commitar secrets (tokens, chaves privadas, credenciais ou conteúdo de `.env`).
- Não logar dados pessoais (PII) em logs de aplicação.
- Persistir sessões do worker em `/data`.
- Usar a Supabase Service Role somente no backend.
