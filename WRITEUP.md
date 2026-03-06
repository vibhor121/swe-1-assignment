# Ticket Service – Write-up

## The bugs

When I first looked at the code I honestly thought it seemed fine at first glance. The function checks availability, inserts the tickets, then decrements the count. Straightforward enough. But the problem is those are just three separate database queries fired one after another — nothing is connecting them or protecting them from other requests sneaking in between.

So when two requests hit at the same time (which is basically guaranteed during a high-demand launch), both of them read the availability before either one has written anything back. They both see the same number, both pass the check, both insert their tickets, and then both decrement. Here's what that actually looks like:

```
Request A reads available = 10
Request B reads available = 10     <-- same value, neither has written yet
Request A: 10 >= 8, passes check, inserts 8 tickets
Request B: 10 >= 8, passes check, inserts 8 tickets
Request A: UPDATE available = available - 8  --> 2
Request B: UPDATE available = available - 8  --> -6
```

So you end up at -6 even though you only had 10 tickets. That's the overselling.

The duplicate ticket numbers are the same problem showing up differently. The ticket number gets calculated from `total - available`. If both requests read the same `available` before either one commits, they both compute the same base and generate the exact same ticket numbers. Two different people end up with ticket #91, two people get #92, and so on.

---

## How I fixed it

The fix is `SELECT FOR UPDATE` inside a transaction. It tells Postgres to lock that row while you're working on it so nothing else can touch it until you're done.

```sql
BEGIN;
SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE;
-- check availability, insert tickets, update count
COMMIT;
```

When Request B hits that SELECT, it waits until Request A finishes and commits. By then the count is already updated, so B reads the real number and not the stale one. No more race condition.

I went with this mainly because it doesn't need any extra infrastructure — it's just Postgres doing what it's built to do. The code is also easy to follow, which matters a lot when someone else has to debug it at 2am during a launch.

The only real downside is that purchases for the same event now run one at a time. For most events that's totally fine, but if you're handling like 50k+ requests per second on the same event it could start adding latency. That's where the Redis version comes in.

---

## Reproducing the bugs

I wrote `reproduce-bugs.ts` to show both bugs happening on the original code. It sets up a fresh event with 100 tickets and fires 20 requests at the same time, each asking for 8 — so 160 tickets demanded when only 100 exist.

```bash
npm run seed        # reset the database
npm run dev         # start the server in one terminal
npm run reproduce   # run this in a second terminal
```

On the original code you'll see `available` go negative and duplicates in the database. On the fixed version, requests that can't be filled get rejected and all ticket numbers come out unique.

---

## Bonus: what I'd do at much higher scale

The Postgres fix handles a lot, but the row lock is still one request at a time per event. If you're running multiple instances of the service and hammering the same event with tens of thousands of requests per second, that queue gets long fast.

What I implemented in `ticketServiceRedis.ts` moves the hot path into Redis. Instead of hitting the database, you hit an in-memory counter — and the key thing is Redis runs Lua scripts atomically, meaning the whole check-and-decrement happens as one operation with no gaps for anything to sneak in.

```lua
if redis.call("EXISTS", avail_key) == 0 then return -1 end
local available = tonumber(redis.call("GET", avail_key))
if available < qty then return -2 end
redis.call("DECRBY", avail_key, qty)
local base = redis.call("INCRBY", counter_key, qty)
return base - qty
```

Each purchase gets a unique starting number from the `INCRBY` counter, so even with many instances running at once, no two batches can overlap. After Redis confirms the purchase, the ticket data gets written to Postgres in the background.

The tradeoff is basically speed vs complexity. Redis is way faster — sub-millisecond vs 5-15ms — and it doesn't have the single-row lock problem. But now you need Redis running, you need to think about what happens if it crashes before the Postgres write happens, and there's just more stuff that can go wrong. In production you'd put the async write behind something durable like BullMQ or SQS to handle crashes properly.

Honestly I'd ship the Postgres version first. It's solid, it's simple, and for most events it'll be more than enough. I'd only pull in Redis if I actually had numbers showing the lock was causing problems.
