#!/usr/bin/env bash
#
# fix-lecture-extraction.sh — pull the EDUC 475 lecture PDFs into the brain,
# and revive the scheduled-job layer.
#
# BACKGROUND (two separate bugs):
#   A. The one-time vault setup from 20260707000010_v0_cron_vault_config.sql was
#      never run, so all six vault-based cron ticks no-op.
#   B. llamaparse_poller_cron_tick (20260719000011) was written with the
#      PRE-VAULT GUC pattern, which can never work on Supabase Cloud
#      (`alter database ... set` is denied). Fixed by migration
#      20260811000000_v0_llamaparse_poller_vault_config.sql.
#
# Consequence: 13 EDUC 475 lecture PDFs (Week 1/2/3/5 slides, VIPKID, Geekie,
# GSV/HBS, LEAD cases, Business Plan Guidelines) have sat as filename-only
# stubs since 2026-07-20, and nothing has auto-synced since.
#
# PREREQUISITES — do these two first, then run this script:
#
#   1. Create the vault secrets. In the Supabase SQL editor
#      (Dashboard > SQL Editor), run with YOUR real values:
#
#        select vault.create_secret('https://hgibayteggcyciddnyry.supabase.co', 'rumbo_supabase_url');
#        select vault.create_secret('<service_role_key>', 'rumbo_service_role_key');
#        select vault.create_secret('<CRON_SECRET>',      'rumbo_cron_secret');
#
#      (service_role_key: Dashboard > Project Settings > API. Use the SQL
#      editor rather than a shell so the values never enter your history.)
#
#      Verify:  select name from vault.decrypted_secrets where name like 'rumbo_%';
#
#   2. Push the poller fix:   supabase db push
#
# USAGE:
#   export CRON_SECRET='<same value you put in the vault>'
#   bash scripts/fix-lecture-extraction.sh
#
# Safe to re-run: canvas-file-extract only touches records whose
# raw_payload.rumbo_content_extracted_at is still NULL.

set -euo pipefail

PROJECT_REF="hgibayteggcyciddnyry"
BASE="https://${PROJECT_REF}.supabase.co"
USER_ID="0efa0af8-cace-418c-9992-fc10f393299c"
COURSE_ID="canvas_course_221697"   # EDUC 475

if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "ERROR: export CRON_SECRET first (must match the rumbo_cron_secret vault value)." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

q() { supabase db query --linked "$1" 2>/dev/null | sed -n '/^{/,$p'; }

echo "==> 1/5  Checking prerequisites"
# Ask the same security-definer helper the cron ticks use. vault.decrypted_secrets
# is NOT readable by the Management API role (it returns 0 rows rather than an
# error, which looks exactly like "not configured" — a false negative). This
# returns booleans only; secret values are never printed.
VAULT_JSON="$(q "select (fn_url_base is not null) as url_ok, (service_key is not null) as key_ok, (cron_secret is not null) as secret_ok from public._rumbo_cron_config();")"
echo "    vault config visible to cron ticks: ${VAULT_JSON:-<no result>}"
if ! printf '%s' "$VAULT_JSON" | grep -q '"secret_ok": *true'; then
  echo "    WARNING: cron config looks incomplete. The scheduled poller may not fire."
  echo "    Steps 2 and 4 below call the functions directly with your CRON_SECRET and"
  echo "    do not depend on cron — but step 3 (draining the queue) does. If step 3"
  echo "    stalls, create/repair the vault secrets per this file's header."
fi

echo "==> 2/5  Enqueuing extraction for un-extracted Canvas files"
curl -fsS -X POST "${BASE}/functions/v1/canvas-file-extract" \
  -H "x-cron-secret: ${CRON_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"${USER_ID}\"}" | head -c 1200
echo

echo "==> 3/5  Draining the LlamaParse queue"
echo "    Calling the poller DIRECTLY (not waiting on cron) so this works even if"
echo "    the scheduled job is unhealthy. Each success writes parsed markdown into"
echo "    normalized_events.normalized_text and resets pipeline_version_v4 so the"
echo "    brain reprocesses that record."
for i in $(seq 1 20); do
  curl -fsS -X POST "${BASE}/functions/v1/llamaparse-poller" \
    -H "x-cron-secret: ${CRON_SECRET}" \
    -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1 || true
  PENDING="$(q "select count(*) as n from llamaparse_jobs j join normalized_events e on e.id=j.normalized_event_id where j.status='pending' and e.course_id='${COURSE_ID}';" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['rows'][0]['n'])" 2>/dev/null || echo '?')"
  echo "    [poll ${i}] EDUC 475 jobs still pending: ${PENDING}"
  [[ "$PENDING" == "0" ]] && break
  sleep 20
done

echo "==> 4/5  Rebuilding the graph for newly extracted records"
curl -fsS -X POST "${BASE}/functions/v1/brain-pipeline-v4" \
  -H "x-cron-secret: ${CRON_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"${USER_ID}\",\"limit\":30}" | head -c 800
echo

echo "==> 5/5  Verifying — lecture text lengths (were 31-147 chars = filenames only)"
q "select count(*) n, round(avg(length(normalized_text))) avg_len, max(length(normalized_text)) max_len from normalized_events where course_id='${COURSE_ID}' and source_type='canvas_lecture';"

echo
echo "Done. If avg_len is now in the thousands, the lecture PDFs are in."
echo "Ask the tutor: \"What did we cover in the VIPKID case study?\" — it should"
echo "answer from slide content instead of saying it only sees titles."
