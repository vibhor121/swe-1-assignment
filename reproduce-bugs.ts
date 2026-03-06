/**
 * reproduce-bugs.ts
 *
 * Demonstrates the two race conditions in the original ticketService.ts:
 *   Bug 1 — Overselling:        available goes negative
 *   Bug 2 — Duplicate numbers:  multiple rows share the same ticket_number
 *
 * Run this script AGAINST THE UNMODIFIED codebase to observe both bugs.
 * Run it again after applying the fix to confirm they are resolved.
 *
 * Usage:
 *   npm run seed        # reset DB to a clean state
 *   npm run dev         # start the server in a separate terminal
 *   npm run reproduce   # fire concurrent requests and inspect the DB
 */

import { Pool } from "pg";
import * as http from "http";

// ─── Config ──────────────────────────────────────────────────────────────────

const EVENT_ID = "RACE001";
const TOTAL_TICKETS = 100;
const QUANTITY_PER_REQUEST = 8;
// 20 requests × 8 tickets = 160 demanded against 100 available → will oversell
const CONCURRENT_REQUESTS = 20;

const SERVER_URL = "http://localhost:3000/purchase";

const pool = new Pool({
  host: "localhost",
  port: 5433,
  database: "tickets",
  user: "postgres",
  password: "postgres",
});

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function postJSON(
  url: string,
  body: object,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seedEvent(): Promise<void> {
  await pool.query("DELETE FROM issued_tickets WHERE event_id = $1", [EVENT_ID]);
  await pool.query("DELETE FROM ticket_pools WHERE event_id = $1", [EVENT_ID]);
  await pool.query(
    "INSERT INTO ticket_pools (event_id, total, available) VALUES ($1, $2, $3)",
    [EVENT_ID, TOTAL_TICKETS, TOTAL_TICKETS],
  );
  console.log(`Seeded event ${EVENT_ID}: ${TOTAL_TICKETS} tickets available.\n`);
}

// ─── Fire concurrent requests ─────────────────────────────────────────────────

async function fireRequests(): Promise<void> {
  console.log(
    `Firing ${CONCURRENT_REQUESTS} concurrent requests (${QUANTITY_PER_REQUEST} tickets each)`,
  );
  console.log(
    `Total demanded: ${CONCURRENT_REQUESTS * QUANTITY_PER_REQUEST} | Supply: ${TOTAL_TICKETS}\n`,
  );

  const requests = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
    postJSON(SERVER_URL, {
      userId: `user_${i + 1}`,
      eventId: EVENT_ID,
      quantity: QUANTITY_PER_REQUEST,
    }),
  );

  const results = await Promise.all(requests);
  const ok = results.filter((r) => r.status === 200).length;
  const fail = results.filter((r) => r.status !== 200).length;
  console.log(`Succeeded: ${ok} | Failed: ${fail}\n`);
}

// ─── Check for bugs ───────────────────────────────────────────────────────────

async function checkForBugs(): Promise<void> {
  console.log("=== Bug Detection ===\n");

  // Bug 1: overselling
  const poolRow = await pool.query<{ available: number }>(
    "SELECT available FROM ticket_pools WHERE event_id = $1",
    [EVENT_ID],
  );
  const available = poolRow.rows[0]?.available ?? 0;
  if (available < 0) {
    console.log(`BUG 1 DETECTED — available = ${available} (tickets OVERSOLD)`);
  } else {
    console.log(`Bug 1 OK — available = ${available} (no overselling)`);
  }

  // Bug 2: duplicate ticket numbers
  const dupes = await pool.query<{ ticket_number: number; count: string }>(
    `SELECT ticket_number, COUNT(*) AS count
     FROM issued_tickets
     WHERE event_id = $1
     GROUP BY ticket_number
     HAVING COUNT(*) > 1
     ORDER BY ticket_number`,
    [EVENT_ID],
  );

  if (dupes.rows.length > 0) {
    console.log(
      `\nBUG 2 DETECTED — ${dupes.rows.length} duplicate ticket number(s):`,
    );
    dupes.rows.slice(0, 10).forEach((r) =>
      console.log(`  ticket_number=${r.ticket_number} issued ${r.count}×`),
    );
    if (dupes.rows.length > 10) {
      console.log(`  … and ${dupes.rows.length - 10} more`);
    }
  } else {
    console.log(`Bug 2 OK — no duplicate ticket numbers`);
  }

  // Summary
  const issued = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM issued_tickets WHERE event_id = $1",
    [EVENT_ID],
  );
  console.log(`\nTotal issued tickets in DB : ${issued.rows[0]?.count}`);
  console.log(
    `Expected max (if correct)  : ${Math.min(CONCURRENT_REQUESTS * QUANTITY_PER_REQUEST, TOTAL_TICKETS)}`,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await seedEvent();
    await fireRequests();
    await checkForBugs();
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
