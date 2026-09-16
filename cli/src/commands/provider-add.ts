import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { configPathInDir, loadConfigAt, type QmConfig } from "../config.ts";
import { CliError, errMessage, note, ok } from "../log.ts";
import { deploymentSecretValue, readEnvFile } from "../util.ts";

/** Same source-auth scheme the deployment layer and portal use to reach the core admin API. */
function signedRequestHeaders(
  secret: string,
  method: string,
  pathWithQuery: string,
  body = "",
  base: Record<string, string> = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const canonical = `${method}\n${pathWithQuery}\n${body}`;
  const signature = createHmac("sha256", secret).update(`v0:${nowSec}:${canonical}`).digest("hex");
  return { ...base, "x-timestamp": String(nowSec), "x-signature": `v0=${signature}` };
}

function withSourceAuthNonce(pathWithQuery: string): string {
  const url = new URL(pathWithQuery, "http://core.local");
  url.searchParams.set("_sourceAuthNonce", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return `${url.pathname}${url.search}`;
}

export interface ProviderAddOptions {
  id: string;
  name?: string;
  protocol: string;
  baseUrl: string;
  models: string[];
  apiKey?: string;
  admin?: string;
  validate: boolean;
  configPath?: string;
  envFile?: string;
}

const PROTOCOLS = ["openai", "anthropic"] as const;
export { PROTOCOLS };

function readSecret(env: Map<string, string>, name: string): string | undefined {
  return deploymentSecretValue(name, env.get(name));
}

/** Reuse the admin-login rule: the admin actor is the single ADMIN_GRANTS org_admin email. */
function adminEmail(env: Map<string, string>, explicit?: string): string {
  if (explicit) return explicit.trim().toLowerCase();
  const grants = readSecret(env, "ADMIN_GRANTS");
  const emails = (grants ?? "")
    .split(",")
    .flatMap((entry) => {
      const separator = entry.lastIndexOf(":");
      return entry.slice(separator + 1).trim() === "org_admin" ? [entry.slice(0, separator).trim().toLowerCase()] : [];
    })
    .filter((email) => email.length > 0);
  if (emails.length !== 1) {
    throw new CliError(
      "provider add requires one org_admin email in ADMIN_GRANTS; use --admin <email> to choose among configured admins",
    );
  }
  return emails[0]!;
}

export async function runProviderAdd(options: ProviderAddOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = options.configPath ?? configPathInDir(cwd);
  const loaded = configPath ? loadConfigAt(configPath) : undefined;
  if (!loaded) throw new CliError("provider add must run inside a deployment directory (qm init)");
  const config: QmConfig = loaded.config;
  const configDir = dirname(loaded.path);
  const env = readEnvFile(options.envFile ?? join(configDir, ".env"));

  const secret = readSecret(env, "CORE_SIGNING_SECRET");
  if (!secret) {
    throw new CliError(
      "provider add requires CORE_SIGNING_SECRET in .env — the deployment layer and admin API use the same signed HTTP trust",
    );
  }
  if (!PROTOCOLS.includes(options.protocol as (typeof PROTOCOLS)[number])) {
    throw new CliError(`--protocol must be one of ${PROTOCOLS.join(" | ")}`);
  }
  const models = options.models.map((model) => model.trim()).filter((model) => model.length > 0);
  if (models.length === 0) {
    throw new CliError("provider add requires at least one model id (--models openai/gpt-4o,deepseek-v4-flash)");
  }
  const apiKey = options.apiKey ?? "";
  const admin = adminEmail(env, options.admin);

  const origin = config.publicUrl.replace(/\/$/, "");
  const path = `/v1/admin/custom-providers/${encodeURIComponent(options.id)}`;
  const noncedPath = withSourceAuthNonce(path);
  const body = JSON.stringify({
    name: options.name ?? options.id,
    protocol: options.protocol,
    baseUrl: options.baseUrl.trim().replace(/\/+$/, ""),
    models,
    ...(apiKey ? { apiKey } : {}),
    validate: options.validate,
  });
  const baseHeaders = {
    "content-type": "application/json",
    "x-admin-actor": `${admin}@${config.orgId}`,
  };
  const headers = signedRequestHeaders(secret, "PUT", noncedPath, body, baseHeaders);

  note(`provider add: ${options.id} (${options.protocol} @ ${options.baseUrl}) via ${origin}`);
  let text: string;
  let status: number;
  try {
    const response = await fetch(`${origin}${noncedPath}`, {
      method: "PUT",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    throw new CliError(`provider add: could not reach ${origin} — ${errMessage(error)}`);
  }
  if (status < 200 || status >= 300) {
    throw new CliError(`provider add failed (${status}): ${text}`);
  }
  ok(`provider ${options.id} registered: ${text}`);
}