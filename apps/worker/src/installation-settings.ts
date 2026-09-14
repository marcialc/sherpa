import { DurableObject } from "cloudflare:workers";
import { gatewayConfigSchema, type CloudflareGatewayConfig } from "@sherpa/models";
import type { GatewayStatus } from "./billing";

export class InstallationSettings extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS gateway (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL,
        gateway_id TEXT NOT NULL,
        token TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async getGateway(): Promise<CloudflareGatewayConfig | null> {
    const row = this.ctx.storage.sql
      .exec<{ account_id: string; gateway_id: string; token: string }>(
        "SELECT account_id, gateway_id, token FROM gateway WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return null;
    const parsed = gatewayConfigSchema.safeParse({
      accountId: row.account_id,
      gatewayId: row.gateway_id,
      apiToken: row.token,
    });
    return parsed.success ? parsed.data : null;
  }

  async status(): Promise<GatewayStatus> {
    const row = this.ctx.storage.sql
      .exec<{ account_id: string; gateway_id: string; updated_at: number }>(
        "SELECT account_id, gateway_id, updated_at FROM gateway WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return { configured: false };
    return {
      configured: true,
      accountId: row.account_id,
      gatewayId: row.gateway_id,
      updatedAt: row.updated_at,
    };
  }

  async putGateway(input: CloudflareGatewayConfig): Promise<void> {
    const config = gatewayConfigSchema.parse(input);
    this.ctx.storage.sql.exec(
      `INSERT INTO gateway(id, account_id, gateway_id, token, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         gateway_id = excluded.gateway_id,
         token = excluded.token,
         updated_at = excluded.updated_at`,
      config.accountId,
      config.gatewayId,
      config.apiToken,
      Date.now(),
    );
  }

  async clear(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM gateway");
  }
}
