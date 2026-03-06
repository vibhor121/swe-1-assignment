import { Pool } from "pg";

interface TicketPool {
  event_id: string;
  total: number;
  available: number;
}

const pool = new Pool({
  host: "localhost",
  port: 5433,
  database: "tickets",
  user: "postgres",
  password: "postgres",
});

export async function purchaseTickets(
  userId: string,
  eventId: string,
  quantity: number,
): Promise<number[]> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // SELECT FOR UPDATE acquires an exclusive row-level lock on this event's
    // ticket_pools row. Any concurrent request hitting the same SELECT FOR UPDATE
    // will block until this transaction commits or rolls back, ensuring:
    //   - The availability check and decrement are atomic (no overselling).
    //   - currentTotal is computed from the latest committed value (no duplicate numbers).
    const availableResult = await client.query<TicketPool>(
      "SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE",
      [eventId],
    );

    if (availableResult.rows.length === 0) {
      throw new Error("Event not found");
    }

    const ticketPool = availableResult.rows[0];

    if (!ticketPool || ticketPool.available < quantity) {
      throw new Error("Not enough tickets available");
    }

    const currentTotal = ticketPool.total - ticketPool.available;
    const ticketNumbers: number[] = [];

    for (let i = 0; i < quantity; i++) {
      const ticketNumber = currentTotal + i + 1;
      ticketNumbers.push(ticketNumber);

      await client.query(
        "INSERT INTO issued_tickets (event_id, user_id, ticket_number) VALUES ($1, $2, $3)",
        [eventId, userId, ticketNumber],
      );
    }

    await client.query(
      "UPDATE ticket_pools SET available = available - $1 WHERE event_id = $2",
      [quantity, eventId],
    );

    await client.query("COMMIT");
    return ticketNumbers;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getPool(): Promise<Pool> {
  return pool;
}
