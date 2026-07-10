-- db/tenant/migrations/0004_party_refs_guard.sql
-- I6 defense-in-depth (REQ-015): party_refs feeds the party-lens WHERE via json_each. A scalar
-- or malformed party_refs would match at the SQL level, then rowToEvent's Zod parse throws and
-- denies the WHOLE lens page (one corrupt row → 500). Reject a non-array party_refs at WRITE
-- time so such a row can never land — confidentiality already holds (Zod is the backstop); this
-- restores availability. Body stays exactly one RAISE(ABORT); the WHEN clause decides when to
-- fire (same pattern as 0003). Forward-only: 0001-0003 stay untouched — this is a NEW file.
CREATE TRIGGER events_party_refs_guard_ins BEFORE INSERT ON events WHEN json_type(NEW.party_refs) IS NOT 'array' BEGIN SELECT RAISE(ABORT,'party_refs must be a JSON array'); END;
