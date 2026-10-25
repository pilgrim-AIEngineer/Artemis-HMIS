/**
 * Drizzle schema entry point. Tables arrive from FND-04/05 onwards (docs/04-data-model.md).
 * Rules: singular snake_case tables, `facility_id` + audit columns on every table, money as
 * bigint paise, UUIDv7 ids (AGENTS.md §3). Migrations are additive only.
 */
export {};
