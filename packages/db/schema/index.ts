/**
 * Drizzle schema entry point (docs/04-data-model.md).
 * Rules: singular snake_case tables, `facility_id` + audit columns on every table, money as
 * bigint paise, UUIDv7 ids (AGENTS.md §3). Migrations are additive only.
 * New business tables: call `hmis_register_business_table()` in a custom migration (see README).
 */
export * from './platform';
export * from './masters';
export * from './patient';
export { currentAppUserId } from './columns';
export * from './visit';
export * from './billing';
