# SHUDDL — Event Taxonomy & Data Model
## Genesis doc 10 · 2026-07-09 · the unambiguous foundation: 35 event kinds, 21 tables (budget ≤22, one slot deliberately spare)

## (01) EVENT KINDS — the complete v1 catalog (adding a kind = a REQ row + register review)
**Demand/Quote:** `quote.requested` · `quote.priced` (payload: sell, floors{contribution,full,target}, versions, basis) · `quote.sent` · `quote.accepted` · `quote.expired`
**Booking/Prep:** `booking.created` · `credit.checked` · `appointment.set` · `pickup.scheduled` · `dispatch.assigned`
**Physical (co-signed where custody moves):** `stop.arrived` (geo+accuracy) · `freight.counted` · `freight.photographed` (hash) · `dims.captured` · `custody.transferred` (co-sign) · `seal.applied` · `stop.departed` · `position.updated` · `exception.raised` · `osd.captured` · `pod.signed` (signature hash + geo) · `delivery.evidenced` (placed-freight photo hash)
**Money (projections):** `invoice.issued` · `invoice.corrected` (reversal semantics) · `payment.received` · `settlement.executed` · `split.computed`
**Communication:** `message.received` · `message.sent` · `call.transcribed`
**Control:** `document.attached` · `approval.requested` · `approval.decided` · `agent.acted` (basis links, cost) · `authority.flipped`
Rules: every event = `{id, shipment_id?, party_refs[], seq, ts, actor{party,user,device}, kind, payload jsonb, evidence[]{doc_id,hash}, prev_hash, sig, visibility, source{native|legacy|edi|email}, confidence}`. Corrections never mutate; `position.updated` is high-volume and stored in a partitioned stream but hashes into the daily Merkle root like everything else.

## (02) TABLES — control plane (4)
1. **tenants** (id, name, slug, plan, policy jsonb: floors/margins/gates/visibility, divisions[], pro_ranges, created)
2. **users** (id, tenant_id, email, role[admin|ops|finance|read|driver|portal], auth{magic,sso}, device_keys[])
3. **pairings** (id, tenant_id, kind[mcp|api|webhook|edi], scopes, caps{spend,velocity,lanes}, secret_ref, status)
4. **usage_credits** (id, tenant_id, period, metered jsonb per agent-action, stripe_refs) — the Spark/credits meter (REQ-123)

## (03) TABLES — tenant data (17)
5. **parties** (id, kind[shipper|consignee|carrier|broker|cartage|factor|insurer], names, addresses jsonb, contacts jsonb, credit{status,limit,terms}, division, bill_terms_default, external_refs jsonb)
6. **passports** (party_id, identity checks, authority, insurance{COI,expiry}, behavior scores{otd,claims,pay}, consents) — network layer (REQ-009)
7. **shipments** (id, tenant, division/company, refs jsonb{pro,bol,master_job,partner}, shipper/consignee/bill_to→parties, bill_terms, service, mode[LTL|TL|brokered|cartage|dray|transload], commodities jsonb{pieces,weight,dims,density,class_passthrough}, service_flags{cod,hazmat,liftgate…}, status_cache, created)
8. **legs** (id, shipment_id, seq, kind[pickup|linehaul|interline|cartage|delivery|dray], executor→party, custody_state, split_pct, geo{o,d})
9. **events** (per §01; PK (shipment_id, seq); device stream merge keys) + **positions** partition
10. **documents** (id, shipment/party, kind[BOL|POD|photo|WI_cert|invoice|ratecon|COI|W9|claim], r2_key, hash, lifecycle_class, visibility)
11. **money_lines** (id, shipment_id, event_id, direction[ar|ap], kind[freight|fsc|accessorial|correction_credit|correction_debit|interline_split|cod_collect|settle_fee|credit_purchase], amount, basis jsonb, gl_map)
12. **invoices** (id, shipment_ids[] via master_job, party, totals, status, issued_event, pdf_doc, terms, due)
13. **messages** (id, channel[email|sms|voice|portal|note], direction, party_id?, shipment_id?, resolved_conf, thread, body_ref, drafted_by_agent?, sla_due)
14. **approvals** (id, object{kind,id}, rule, required_role, requested_event, decided_event, status)
15. **facilities** (id, party_id?, kind[terminal|dock|yard], geo, hours jsonb, capacity_slots jsonb, appointment_rules) — REQ-052
16. **assets** (id, unit#, kind[tractor|trailer|pup], status, home_facility) — parity G1
17. **rate_config** (id, version, kind[zone_tariff|floors|fsc|accessorials|transit_matrix|class_adapter], payload jsonb, effective, approved_by) — versioned; every quote pins ids
18. **agent_runs** (id, agent, trigger_event, actions[], basis[], confidence, cost{tokens,$}, latency, outcome) — REQ-039/113
19. **authority_map** (module[rating|invoicing|dispatch|settlement|comms], authority[native|legacy], gates_status jsonb, flipped_events[]) — L8
20. **anomalies** (id, rule, object, severity, detail, status) — Watchtower
21. **integrations** (id, kind[edi_partner|eld|quickbooks|email_inbox|tiles|tsa], config, cert_status, replay_fixture_ref)
**Spare slot:** 1 remaining of the ≤22 budget — spending it requires a written deletion elsewhere (doc 11 rule). Claims live as event-chains + documents + money_lines (no claims table needed); KPIs, boards, aging, lane P&L, scoreboards are **views over events/money_lines — never tables.**

## (04) DERIVED SURFACES (views, materialized where hot)
`v_board` (live map entities per lens) · `v_queue_{approvals,exceptions,money}` · `v_kpi_strip` (OR, DSO, unbilled, OTD, dwell) · `v_lane_pnl` · `v_aging` · `v_scoreboards` · `v_unbilled` (alarm source) · `v_parity` (overlay dashboards). Twelve canonical views total (REQ-084) — adding a thirteenth requires deleting one.

## (05) INVARIANTS (CI-enforced, the schema's laws)
I1 no money_line without event · I2 no invoice without pod.signed (unless tenant policy names an exception class) · I3 no event edit/delete grants exist at DB level · I4 every custody event co-signed or explicitly flagged `unwitnessed` · I5 every quote pins rate_config versions · I6 events.visibility respected by every view (tested adversarially) · I7 correction pairs net zero in GL export · I8 any 22nd table = build failure without a register amendment + written deletion.
