# Custom model providers

QM can route model traffic to your own OpenAI- or Anthropic-compatible gateway
(GPUStack, NVIDIA NIM, Ollama, vLLM, LiteLLM) so prompts never leave your
corporate boundary. Custom providers are separate from the built-in
`anthropic`/`openai`/`openrouter` keys configured in `.env`; they are registered
durably through the admin API and resolved at runtime via
`builtinModel(id) ?? customModel(id)`.

## Register with the CLI

From a deployment directory (`qm init`), register a provider against the live
core. The command signs its admin call with `CORE_SIGNING_SECRET` from the
deployment `.env` and addresses the core at `publicUrl`:

```bash
qm provider add <id> --protocol openai --base-url https://gateway.example/v1 \
  --models deepseek-v4-flash --name "My gateway"
```

- `--protocol` is `openai` or `anthropic`.
- `--base-url` is the gateway base URL; a trailing slash is stripped.
- `--models` is a comma-separated list of model ids the gateway serves.
- `--name` defaults to the provider id.
- `--admin <email>` selects the admin actor when `ADMIN_GRANTS` lists more than
  one `org_admin`; by default the single `:org_admin` email from `ADMIN_GRANTS`
  is used.
- `--no-validate` skips the live key check against `GET {base-url}/models`.
- `--api-key <key>` supplies the gateway key non-interactively (for scripts/CI).
  When omitted on a TTY the CLI prompts hidden, so the key never reaches shell
  history.

The command is idempotent: re-running with the same `<id>` overwrites the
entry, and an existing key is preserved when a new one is not supplied.

## Admin and onboarding status

Configured custom providers are aggregated into `GET /v1/admin/model-providers`
with `source: "admin"` when a key is stored, so the onboarding UI shows them as
ready rather than "Needs a key". A keyed custom provider also satisfies the
`modelProviderConfigured` surface-config gate, so the web UI and portal no
longer redirect admins to onboarding.

## Storage

Provider specs and keys live durably in Postgres (encrypted with
`CONNECTOR_SECRET_KEY`), surviving core restarts and redeploys. Keep
`CONNECTOR_SECRET_KEY` stable across restarts or stored keys become
undecryptable.

## Docs for the admin API

The same registration is available programmatically as
`PUT /v1/admin/custom-providers/:id` with a source-auth signed request and
`x-admin-actor: <admin>@<org>`. A provider added without a key reports
`configured: false` (its `hasKey` is honestly `false`) until a key is supplied.
