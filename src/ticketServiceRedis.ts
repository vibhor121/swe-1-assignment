/**
 * ticketServiceRedis.ts — High-performance ticket service using Redis + Lua.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The PostgreSQL SELECT FOR UPDATE fix is correct and works well for typical
 * event loads (thousands of req/s). However, FOR UPDATE serialises all purchases
 * for a given event through a single DB row lock. Under extreme concurrency
 * (tens of thousands of req/s across multiple service instances) that lock
 * becomes a throughput bottleneck.
 *
 * Redis solves this with two primitives:
 *   1. Atomic in-memory counters (DECRBY / INCRBY) — ~100× faster than a
 *      Postgres write, no disk I/O.
 *   2. Lua scripts — Redis runs Lua atomically (single-threaded event loop),
 *      so the check-and-decrement is one indivisible operation with zero race
 *      window.
 *
 * ARCHITECTURE
 * ────────────
 *   Client → Lua script (Redis) → async persist → Postgres
 *
 *   Redis is the source of truth for availability and ticket numbering.
 *   Postgres is the durable record of every sale.
 *
 * TRADEOFFS vs Postgres FOR UPDATE
 * ──────────────────────────────────
 *  Pros:
 *   • Sub-millisecond latency (in-memory vs ~5–15 ms DB round-trip + lock wait)
 *   • Scales horizontally — no single-row lock bottleneck
 *   • Lua script = no TOCTOU race at all
 *
 *  Cons:
 *   • Requires Redis as extra infrastructure
 *   • Redis is not durable by default; data can be lost on crash before
 *     it is flushed to Postgres (mitigated with AOF/RDB persistence or a
 *     durable write queue such as BullMQ or SQS)
 *   • More operational complexity
 *
 * Redis key schema:
 *   ticket:available:{eventId}  — remaining tickets
 *   ticket:counter:{eventId}    — monotonic ticket-number counter
 *   ticket:total:{eventId}      — total capacity (informational)
 */

import Redis from "ioredis";
import { Pool } from "pg";

const redis = new Redis({ host: "localhost", port: 6379 });

const pool = new Pool({
  host: "localhost",
  port: 5433,
  database: "tickets",
  user: "postgres",
  password: "postgres",
});

// ─── Lua script (runs atomically inside Redis) ────────────────────────────────
//
// Returns:
//   -1  event not initialised in Redis
//   -2  not enough tickets available
//    N  (≥ 0) ticket-number base — caller assigns numbers [N+1 … N+quantity]
//
const PURCHASE_SCRIPT = `
local avail_key   = KEYS[1]
local counter_key = KEYS[2]
local qty         = tonumber(ARGV[1])

if redis.call("EXISTS", avail_key) == 0 then
  return -1
end

local available = tonumber(redis.call("GET", avail_key))
if available < qty then
  return -2
end

redis.call("DECRBY", avail_key, qty)
local base = redis.call("INCRBY", counter_key, qty)
return base - qty
`;

// ─── Initialise an event in Redis ─────────────────────────────────────────────

export async function initEventInRedis(
  eventId: string,
  total: number,
  alreadySold: number,
): Promise<void> {
  const available = total - alreadySold;
  const pipeline = redis.pipeline();
  pipeline.set(`ticket:available:${eventId}`, available);
  pipeline.set(`ticket:counter:${eventId}`, alreadySold);
  pipeline.set(`ticket:total:${eventId}`, total);
  await pipeline.exec();
}

// ─── Purchase tickets (Redis-backed) ─────────────────────────────────────────

export async function purchaseTicketsRedis(
  userId: string,
  eventId: string,
  quantity: number,
): Promise<number[]> {
  const result = (await redis.eval(
    PURCHASE_SCRIPT,
    2,
    `ticket:available:${eventId}`,
    `ticket:counter:${eventId}`,
    String(quantity),
  )) as number;

  if (result === -1) throw new Error("Event not found");
  if (result === -2) throw new Error("Not enough tickets available");

  // result = base; ticket numbers are [base+1 … base+quantity]
  const ticketNumbers: number[] = [];
  for (let i = 1; i <= quantity; i++) {
    ticketNumbers.push(result + i);
  }

 
  persistToPostgres(userId, eventId, ticketNumbers).catch((err) =>
    console.error("[Redis service] Failed to persist tickets to Postgres:", err),
  );

  return ticketNumbers;
}

// ─── Async Postgres persistence ───────────────────────────────────────────────

async function persistToPostgres(
  userId: string,
  eventId: string,
  ticketNumbers: number[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const ticketNumber of ticketNumbers) {
      await client.query(
        "INSERT INTO issued_tickets (event_id, user_id, ticket_number) VALUES ($1, $2, $3)",
        [eventId, userId, ticketNumber],
      );
    }
    await client.query(
      "UPDATE ticket_pools SET available = available - $1 WHERE event_id = $2",
      [ticketNumbers.length, eventId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
