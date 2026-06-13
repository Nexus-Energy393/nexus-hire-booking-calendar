/*
 * scripts/seed-staff.js
 * Seeds test staff, allocations and unavailability for utilisation testing.
 * Usage:
 *   DATABASE_URL="postgres://..." FLEET_ADMIN_TOKEN="..." node scripts/seed-staff.js
 *
 * Creates (idempotently by name):
 *   - Justin Mace (employee, Operations Manager)
 *   - Jordan Mace (employee, Electrician)
 *   - Contractor Electrician (contractor, Electrician)
 *
 * Then seeds allocations and unavailability for the current week.
 */
"use strict";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }

  let neon;
  try { neon = require("@neondatabase/serverless"); } catch (e) {
    console.error("Missing dependency. Run: npm install @neondatabase/serverless"); process.exit(1);
  }
  // Use pool for multiple queries
  let pool;
  try {
    if (neon.neonConfig) neon.neonConfig.webSocketConstructor = require("ws");
    pool = new neon.Pool({ connectionString: url });
  } catch(e) { console.error("Pool setup failed:", e.message); process.exit(1); }

  async function q(text, params) {
    const r = await pool.query(text, params || []);
    return r.rows;
  }

  // ── helpers ──
  // Monday of the current UTC week
  function mondayOfWeek(d) {
    const day = d.getUTCDay() || 7;
    const m = new Date(d);
    m.setUTCDate(d.getUTCDate() - (day - 1));
    m.setUTCHours(8, 0, 0, 0);
    return m;
  }
  function addHours(d, h) { return new Date(d.getTime() + h * 3_600_000); }

  const now   = new Date();
  const mon   = mondayOfWeek(now);
  const tue   = addHours(mon, 24);
  const wed   = addHours(mon, 48);
  const thu   = addHours(mon, 72);
  const fri   = addHours(mon, 96);

  // ── upsert staff (by name) ──
  async function upsertStaff(name, email, role, type) {
    const existing = await q("SELECT staff_id FROM staff WHERE name=$1", [name]);
    if (existing.length) { console.log(`  Staff exists: ${name} (${existing[0].staff_id})`); return existing[0].staff_id; }
    const row = await q(
      "INSERT INTO staff (name,email,role,staff_type) VALUES ($1,$2,$3,$4) RETURNING staff_id",
      [name, email, role, type]
    );
    console.log(`  Created staff: ${name} (${row[0].staff_id})`);
    return row[0].staff_id;
  }

  console.log("\n=== Creating staff members ===");
  const justinId     = await upsertStaff("Justin Mace",            "justin@nexusenergy.au", "Operations Manager",  "employee");
  const jordanId     = await upsertStaff("Jordan Mace",            "jordan@nexusenergy.au", "Electrician",         "employee");
  const contractorId = await upsertStaff("Contractor Electrician", null,                    "Electrician",         "contractor");

  // ── clear this week's test allocations ──
  await q("DELETE FROM staff_allocations WHERE staff_id = ANY($1) AND allocation_start >= $2",
    [[justinId, jordanId, contractorId], mon.toISOString()]);
  await q("DELETE FROM staff_unavailability WHERE staff_id = ANY($1) AND start_time >= $2",
    [[justinId, jordanId, contractorId], mon.toISOString()]);

  console.log("\n=== Seeding allocations ===");

  // 1. Justin: 2h on Monday morning (billable)
  await q(`INSERT INTO staff_allocations
    (staff_id,booking_title,pipedrive_deal_id,allocation_start,allocation_end,duration_hours,billable,billable_hours,status,notes)
    VALUES ($1,'ACE Contractors — Generator Hire',458,$2,$3,2,true,2,'allocated','Site preparation')`,
    [justinId, addHours(mon, 0).toISOString(), addHours(mon, 2).toISOString()]);
  console.log("  Justin: 2h Monday");

  // 2. Justin: 6h on Monday afternoon (same day, creating 8h total)
  await q(`INSERT INTO staff_allocations
    (staff_id,booking_title,pipedrive_deal_id,allocation_start,allocation_end,duration_hours,billable,billable_hours,status,notes)
    VALUES ($1,'ACE Contractors — Generator Hire',458,$2,$3,6,true,6,'allocated','Installation and commissioning')`,
    [justinId, addHours(mon, 2).toISOString(), addHours(mon, 8).toISOString()]);
  console.log("  Justin: 6h Monday (same day, total 8h = 100%)");

  // 3. Jordan: 20h spread Mon–Fri (4h/day)
  for (let d = 0; d < 5; d++) {
    const s = addHours(mon, d * 24);
    await q(`INSERT INTO staff_allocations
      (staff_id,booking_title,allocation_start,allocation_end,duration_hours,billable,billable_hours,status)
      VALUES ($1,'Various hire jobs',$2,$3,4,true,4,'allocated')`,
      [jordanId, s.toISOString(), addHours(s, 4).toISOString()]);
  }
  console.log("  Jordan: 20h across Mon–Fri (50% utilisation)");

  // 4. Contractor: 10 billable hours across the week
  await q(`INSERT INTO staff_allocations
    (staff_id,booking_title,allocation_start,allocation_end,duration_hours,billable,billable_hours,status,notes)
    VALUES ($1,'Electrical contracting',$2,$3,5,true,5,'allocated','Wednesday works')`,
    [contractorId, addHours(wed, 0).toISOString(), addHours(wed, 5).toISOString()]);
  await q(`INSERT INTO staff_allocations
    (staff_id,booking_title,allocation_start,allocation_end,duration_hours,billable,billable_hours,status,notes)
    VALUES ($1,'Electrical contracting',$2,$3,5,true,5,'allocated','Friday works')`,
    [contractorId, addHours(fri, 0).toISOString(), addHours(fri, 5).toISOString()]);
  console.log("  Contractor: 10h billable (Wed 5h + Fri 5h)");

  // 5. Jordan: 8h annual leave on Thursday (reduces available hours)
  await q(`INSERT INTO staff_unavailability
    (staff_id,start_time,end_time,reason,notes)
    VALUES ($1,$2,$3,'annual_leave','Planned annual leave')`,
    [jordanId, addHours(thu, 0).toISOString(), addHours(thu, 8).toISOString()]);
  console.log("  Jordan: 8h annual leave Thursday (available hours reduce to 32h this week)");

  // 6. Overlapping allocation on Jordan — Tuesday 2h overlapping with another 2h (conflict)
  await q(`INSERT INTO staff_allocations
    (staff_id,booking_title,allocation_start,allocation_end,duration_hours,billable,billable_hours,status,notes)
    VALUES ($1,'Site B overlap test',$2,$3,3,true,3,'allocated','Intentional overlap for conflict test')`,
    [jordanId, addHours(tue, 2).toISOString(), addHours(tue, 5).toISOString()]);
  console.log("  Jordan: overlapping 3h Tuesday (overlaps with existing 4h block — conflict count should appear)");

  await pool.end();
  console.log("\n✓ Seed complete. Visit #/staff → Utilisation to view results.");
}

main().catch(function (e) { console.error("Seed failed:", e.message, e.stack); process.exit(1); });
