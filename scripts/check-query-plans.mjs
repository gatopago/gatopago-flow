import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = resolve(import.meta.dirname, "..", "migrations");
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_.+\.sql$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en"));

const database = new DatabaseSync(":memory:");
try {
  for (const migration of migrations) {
    database.exec(readFileSync(resolve(migrationsDirectory, migration), "utf8"));
  }

  const cases = [
    {
      name: "checkout link lookup",
      index: "idx_intents_link_id",
      sql: "SELECT id FROM payment_intents WHERE link_id = ? LIMIT 1",
      values: ["link_1"],
    },
    {
      name: "checkout link projection",
      index: "idx_intents_link_id",
      sql: "SELECT * FROM payment_intents WHERE link_id = ? LIMIT 1",
      values: ["link_1"],
    },
    {
      name: "owner checkout links",
      index: "idx_intents_merchant_cursor",
      sql:
        "SELECT i.* FROM merchants m JOIN payment_intents i ON i.merchant_id = m.id " +
        "WHERE m.owner_user_id = ? AND i.link_id IS NOT NULL ORDER BY i.created_at " +
        "DESC,i.id DESC LIMIT ?",
      values: ["usr_1", 20],
    },
    {
      name: "chain reconciliation batch",
      index: "idx_attempts_source_active_created",
      sql:
        "SELECT DISTINCT router_address FROM payment_attempts WHERE source_chain_id = " +
        "? AND status IN ('reserved','submitted','processing')",
      values: [421614],
    },
    {
      name: "active chain scheduler",
      index: "idx_attempts_status_updated",
      sql:
        "SELECT DISTINCT source_chain_id FROM payment_attempts WHERE status IN " +
        "('reserved','submitted','processing')",
      values: [],
    },
    {
      name: "latest attempt evidence",
      index: "idx_attempts_intent_created",
      sql: "SELECT id FROM payment_attempts WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1",
      values: ["pi_1"],
    },
    {
      name: "active attempts for intent cleanup",
      index: "idx_attempts_intent_active_created",
      sql:
        "SELECT id FROM payment_attempts WHERE intent_id = ? AND status IN " +
        "('reserved','submitted','processing') ORDER BY created_at DESC",
      values: ["pi_1"],
    },
    {
      name: "canonical reorg journal",
      index: "idx_payment_events_chain_canonical_height",
      sql: "SELECT COUNT(*) FROM payment_chain_events WHERE chain_id = ? AND canonical = 1 AND block_number > ?",
      values: [421614, 1],
    },
    {
      name: "rate-limit retention",
      index: "idx_rate_limits_window_start",
      sql: "DELETE FROM rate_limits WHERE window_start < ?",
      values: [1],
    },
    {
      name: "pending fee evidence health",
      index: "idx_payment_fee_ledger_status_created",
      sql: "SELECT COUNT(*) FROM payment_fee_ledger WHERE status = 'quoted'",
      values: [],
    },
    {
      name: "merchant intent cursor",
      index: "idx_intents_merchant_cursor",
      sql: "SELECT id FROM payment_intents WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      values: ["mrc_1", 50],
    },
    {
      name: "merchant event cursor",
      index: "idx_events_merchant_cursor",
      sql: "SELECT id FROM events WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      values: ["mrc_1", 50],
    },
    {
      name: "active merchant webhooks",
      index: "idx_webhook_endpoints_active_mode",
      sql: "SELECT id FROM webhook_endpoints WHERE merchant_id = ? AND status = 'active' AND mode = ?",
      values: ["mrc_1", "live"],
    },
  ];

  for (const item of cases) {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${item.sql}`)
      .all(...item.values)
      .map((row) => String(row.detail))
      .join(" | ");
    if (!plan.includes(item.index)) {
      throw new Error(`${item.name} does not use ${item.index}: ${plan}`);
    }
  }

  const quickCheck = database.prepare("PRAGMA quick_check").get();
  if (quickCheck.quick_check !== "ok") {
    throw new Error(`Payments migration quick_check failed: ${quickCheck.quick_check}`);
  }
  console.log(
    `Flow query-plan check passed (${cases.length} hot paths, migrations ${migrations.join(", ")}).`,
  );
} finally {
  database.close();
}
