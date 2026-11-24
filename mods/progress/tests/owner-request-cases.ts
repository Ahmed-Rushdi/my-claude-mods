// One accept/refuse table for the three owner-request validators, kept in sync by
// hand: dashboard/server.py owner_request, hooks/web_control.py owner_request and
// hooks/web-control.ts isOwnerRequest. Each case is `base` with `set` applied and the
// `drop` keys removed. tests/owner-request.test.ts runs it here; the repository's
// tests/test_owner_request_cases.py reads the JSON between the two marker lines.
export type OwnerRequestCase = { name: string; accept: boolean; set?: Record<string, unknown>; drop?: string[] }

export const OWNER_REQUEST_TABLE: { base: Record<string, unknown>; cases: OwnerRequestCase[] } =
// BEGIN JSON
{
 "base": {"session_id": "5f0c6a2e-1b7d-4c39-9e51-0a7e3d2b8c41", "request_id": "0123456789abcdef0123456789abcdef", "action": "prepare", "repo": "o/r", "pull": 24, "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "base": "main", "confirmation_id": ""},
 "cases": [
  {"name": "prepare with an empty confirmation", "accept": true},
  {"name": "confirm with its confirmation", "accept": true, "set": {"action": "confirm", "confirmation_id": "identity:1"}},
  {"name": "cancel with its confirmation", "accept": true, "set": {"action": "cancel", "confirmation_id": "identity:1"}},
  {"name": "mixed-case 64-digit head", "accept": true, "set": {"head": "aBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaBaB"}},
  {"name": "largest safe pull number", "accept": true, "set": {"pull": 9007199254740991}},
  {"name": "repo with dots, dashes and underscores", "accept": true, "set": {"repo": "a.b_c-d/e.f"}},
  {"name": "100-character owner and name", "accept": true, "set": {"repo": "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"}},
  {"name": "256-character base", "accept": true, "set": {"base": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}},
  {"name": "non-ASCII base", "accept": true, "set": {"base": "rel\u00e4se"}},
  {"name": "200-character confirmation", "accept": true, "set": {"action": "confirm", "confirmation_id": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}},
  {"name": "256 astral characters in base, counted as characters", "accept": true, "set": {"base": "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"}},
  {"name": "200 astral characters of confirmation", "accept": true, "set": {"action": "confirm", "confirmation_id": "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"}},
  {"name": "missing base", "accept": false, "drop": ["base"]},
  {"name": "missing session", "accept": false, "drop": ["session_id"]},
  {"name": "extra field", "accept": false, "set": {"profiles": ["selected"]}},
  {"name": "type field left in", "accept": false, "set": {"type": "owner"}},
  {"name": "session not a UUID", "accept": false, "set": {"session_id": "session-1"}},
  {"name": "upper-case session", "accept": false, "set": {"session_id": "5F0C6A2E-1B7D-4C39-9E51-0A7E3D2B8C41"}},
  {"name": "session not text", "accept": false, "set": {"session_id": 5}},
  {"name": "31-digit request id", "accept": false, "set": {"request_id": "0000000000000000000000000000000"}},
  {"name": "upper-case request id", "accept": false, "set": {"request_id": "0123456789ABCDEF0123456789ABCDEF"}},
  {"name": "unknown action", "accept": false, "set": {"action": "merge"}},
  {"name": "action not text", "accept": false, "set": {"action": null}},
  {"name": "257 astral characters in base", "accept": false, "set": {"base": "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"}},
  {"name": "action as a list", "accept": false, "set": {"action": ["confirm"]}},
  {"name": "repo without a name", "accept": false, "set": {"repo": "o"}},
  {"name": "repo with three parts", "accept": false, "set": {"repo": "o/r/x"}},
  {"name": "repo with a space", "accept": false, "set": {"repo": "o/r x"}},
  {"name": "101-character owner", "accept": false, "set": {"repo": "ooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo/r"}},
  {"name": "zero pull", "accept": false, "set": {"pull": 0}},
  {"name": "negative pull", "accept": false, "set": {"pull": -1}},
  {"name": "fractional pull", "accept": false, "set": {"pull": 1.5}},
  {"name": "pull as text", "accept": false, "set": {"pull": "24"}},
  {"name": "pull as a boolean", "accept": false, "set": {"pull": true}},
  {"name": "pull past the safe integers", "accept": false, "set": {"pull": 9007199254740992}},
  {"name": "39-digit head", "accept": false, "set": {"head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
  {"name": "65-digit head", "accept": false, "set": {"head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
  {"name": "head that is not hex", "accept": false, "set": {"head": "gggggggggggggggggggggggggggggggggggggggg"}},
  {"name": "head with a trailing newline", "accept": false, "set": {"head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"}},
  {"name": "empty base", "accept": false, "set": {"base": ""}},
  {"name": "base with a space", "accept": false, "set": {"base": "ma in"}},
  {"name": "base with DEL", "accept": false, "set": {"base": "main\u007f"}},
  {"name": "base with a newline", "accept": false, "set": {"base": "main\n"}},
  {"name": "257-character base", "accept": false, "set": {"base": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}},
  {"name": "base not text", "accept": false, "set": {"base": 1}},
  {"name": "prepare with a confirmation", "accept": false, "set": {"confirmation_id": "identity:1"}},
  {"name": "confirm without a confirmation", "accept": false, "set": {"action": "confirm"}},
  {"name": "cancel without a confirmation", "accept": false, "set": {"action": "cancel"}},
  {"name": "201-character confirmation", "accept": false, "set": {"action": "confirm", "confirmation_id": "ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}},
  {"name": "confirmation not text", "accept": false, "set": {"action": "confirm", "confirmation_id": 1}}
 ]
}
// END JSON
