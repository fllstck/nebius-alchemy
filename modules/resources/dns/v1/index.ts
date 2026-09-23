export { NebiusZone as Zone, NebiusZoneProvider as ZoneProvider, type NebiusZone as ZoneResource } from './zone.ts'
export { NebiusRecord as Record, NebiusRecordProvider as RecordProvider, type NebiusRecord as RecordResource } from './record.ts'
// Branded ids as **values** (AGENTS.md §"Branded IDs") — a `Record` whose `parentId` is an env-provided
// zone id needs `Nebius.dns.ZoneId` at that boundary.
export { ZoneId, RecordId } from './ids.ts'
