#!/usr/bin/env bash
# Skynet integrated E2E smoke — API-level critical path.
# Boot a seeded server, then run this against it:
#   STORE=memory BUS=memory SESSIONS=memory AUTH_REQUIRED=true SKYNET_SEED=true \
#     PORT=8095 pnpm --filter @skynet/server dev &
#   BASE=http://localhost:8095 bash docs/qa/e2e-smoke.sh
# Exits non-zero if any assertion fails (CI-friendly).
set -u
BASE="${BASE:-http://localhost:8095}"
DEV="authorization: Bearer dev-cyberdyne"
P=0; F=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1 ($3)"; P=$((P+1)); else echo "  FAIL  $1 (want $2, got $3)"; F=$((F+1)); fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }
jq1(){ node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(eval(process.argv[1]))}catch(e){console.log("ERR")}})' "$1"; }

echo "### auth & sessions"
chk "no token → 401"        401 "$(code "$BASE/api/snapshot")"
chk "dev token → 200"       200 "$(code -H "$DEV" "$BASE/api/snapshot")"
chk "bad login → 401"       401 "$(code -H 'content-type: application/json' -X POST "$BASE/api/auth/login" -d '{"email":"jordan@cyberdyne.dev","password":"nope"}')"
TOK=$(curl -s -H 'content-type: application/json' -X POST "$BASE/api/auth/login" -d '{"email":"jordan@cyberdyne.dev","password":"skynet"}' | jq1 'JSON.parse(d).token')
chk "login issues session"  yes "$([ -n "$TOK" ] && [ "$TOK" != ERR ] && echo yes || echo no)"
chk "session → 200"         200 "$(code -H "authorization: Bearer $TOK" "$BASE/api/snapshot")"
curl -s -X POST -H "authorization: Bearer $TOK" "$BASE/api/auth/logout" -o /dev/null
chk "logout → 401"          401 "$(code -H "authorization: Bearer $TOK" "$BASE/api/snapshot")"

echo "### workspace isolation"
chk "resistance isolated"   0 "$(curl -s -H 'authorization: Bearer dev-resistance' "$BASE/api/snapshot" | jq1 'JSON.parse(d).projects.length')"

echo "### HITL resolve → audit trail (idempotent, first-writer-wins)"
HID=$(curl -s -H "$DEV" "$BASE/api/snapshot" | jq1 '(JSON.parse(d).queue.find(x=>x.resolvedAt==null)||{}).id')
chk "open HITL exists"      yes "$([ -n "$HID" ] && [ "$HID" != ERR ] && echo yes || echo no)"
chk "resolve → 200"         200 "$(code -H "$DEV" -H 'content-type: application/json' -X POST "$BASE/api/hitl/$HID/resolve" -d '{"action":"approve"}')"
chk "re-resolve → 200"      200 "$(code -H "$DEV" -H 'content-type: application/json' -X POST "$BASE/api/hitl/$HID/resolve" -d '{"action":"reject"}')"
chk "audit action=approve"  approve "$(curl -s -H "$DEV" "$BASE/api/audit" | jq1 '(JSON.parse(d).find(r=>r.hitlId==="'"$HID"'")||{}).action')"

echo "### providers"
chk "providers listed"      yes "$(curl -s -H "$DEV" "$BASE/api/providers" | jq1 'JSON.parse(d).length>0?"yes":"no"')"

echo
echo "RESULT: $P passed, $F failed"
[ "$F" -eq 0 ]
