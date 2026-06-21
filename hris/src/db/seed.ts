/**
 * Seed data + seeding routine for the directory `employees` table.
 *
 * The first three rows reproduce the original in-memory directory so the
 * existing time-off / payroll flows keep working unchanged:
 *   - e-001 Ada Lovelace       — Engineering, CEO (top of the org chart)
 *   - e-002 Grace Hopper       — Engineering, manager
 *   - e-003 Katherine Johnson  — Finance, manager
 * (their ids and names are read by the TimeOff → Directory `ctx.call` validation
 * path and the gRPC RequestLeave e2e, so they must stay present.)
 *
 * The remaining rows build a small org chart across TWO departments so the
 * `manager_id` (org-chart "direct reports") and `department` filters of
 * ListEmployees are meaningfully testable:
 *
 *   e-001 Ada Lovelace (CEO, Engineering, manager=∅)
 *   ├── e-002 Grace Hopper (Engineering manager)
 *   │   ├── e-004 Alan Turing       (Engineering IC)
 *   │   └── e-005 Margaret Hamilton (Engineering IC, onboarding)
 *   └── e-003 Katherine Johnson (Finance manager)
 *       ├── e-006 Dorothy Vaughan  (Finance IC)
 *       └── e-007 Mary Jackson     (Finance IC)
 *
 * `seedEmployees(db)` is idempotent-ish for demos: it deletes existing rows then
 * inserts the seed set, so re-running (`pnpm db:seed`) or re-seeding between
 * tests yields a known state. Reused by both the CLI script (bottom of file) and
 * the e2e test helper.
 *
 * @module db/seed
 */

import { EmployeeStatus, employees } from "#db/schema.ts";
import type { Db } from "#db/client.ts";
import type { NewEmployeeRow } from "#db/schema.ts";

/** The demo directory — a CEO, two managers, and four individual contributors. */
export const SEED_EMPLOYEES: ReadonlyArray<NewEmployeeRow> = [
    { id: "e-001", name: "Ada Lovelace", email: "ada@example.com", title: "Chief Executive Officer", department: "Engineering", managerId: null, status: EmployeeStatus.ACTIVE },
    { id: "e-002", name: "Grace Hopper", email: "grace@example.com", title: "Engineering Manager", department: "Engineering", managerId: "e-001", status: EmployeeStatus.ACTIVE },
    { id: "e-003", name: "Katherine Johnson", email: "katherine@example.com", title: "Finance Manager", department: "Finance", managerId: "e-001", status: EmployeeStatus.ACTIVE },
    { id: "e-004", name: "Alan Turing", email: "alan@example.com", title: "Staff Engineer", department: "Engineering", managerId: "e-002", status: EmployeeStatus.ACTIVE },
    { id: "e-005", name: "Margaret Hamilton", email: "margaret@example.com", title: "Senior Engineer", department: "Engineering", managerId: "e-002", status: EmployeeStatus.ONBOARDING },
    { id: "e-006", name: "Dorothy Vaughan", email: "dorothy@example.com", title: "Financial Analyst", department: "Finance", managerId: "e-003", status: EmployeeStatus.ACTIVE },
    { id: "e-007", name: "Mary Jackson", email: "mary@example.com", title: "Financial Analyst", department: "Finance", managerId: "e-003", status: EmployeeStatus.ACTIVE },
];

/**
 * Replace the directory with the {@link SEED_EMPLOYEES} set.
 *
 * @param db - Drizzle db (postgres.js in prod, PGlite in tests).
 */
export async function seedEmployees(db: Db): Promise<void> {
    await db.delete(employees);
    await db.insert(employees).values([...SEED_EMPLOYEES]);
}

// CLI entrypoint: `pnpm db:seed`. Connects over postgres.js to DATABASE_URL,
// seeds, and exits. Guarded so importing this module (e.g. from the test helper)
// does NOT open a database connection.
if (import.meta.url === `file://${process.argv[1]}`) {
    const { createDb } = await import("#db/client.ts");
    const db = createDb();
    await seedEmployees(db);
    console.log(`Seeded ${SEED_EMPLOYEES.length} employees.`);
    process.exit(0);
}
