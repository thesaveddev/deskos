# 07 — Data Model (PostgreSQL)

Conventions: every tenant-owned table has `tenant_id uuid NOT NULL` + composite indexes leading with it; RLS enforced; timestamps `timestamptz`; IDs `uuid` (v7); soft-delete only where audit needs it; JSONB for flexible attributes. Below: core tables with key columns (not exhaustive DDL).

## 1. Identity & tenancy

```sql
tenants(id, name, slug, region, plan_id, settings jsonb, created_at)
users(id, email, password_hash, name, role_hint, mfa_enabled, mfa_secret_enc,
      locale, tz, last_login_at, created_at)                    -- platform identity
memberships(id, tenant_id, user_id, org_role, status, invited_by, created_at)
                          -- org_role: owner|manager|analyst|engineer|auditor|end_user|msp_tech…
refresh_tokens(id, user_id, device_fp, expires_at, revoked_at)
api_keys(id, tenant_id, user_id, name, key_hash, scopes[], last_used_at)
teams(id, tenant_id, name, lead_id, business_hours_id, sla_policy_id, settings jsonb)
team_members(team_id, user_id, role)                             -- member|lead
business_hours(id, tenant_id, name, schedule jsonb, holidays jsonb)
```

## 2. RBAC

```sql
roles(id, tenant_id, name, is_system, permissions jsonb)         -- permission strings
user_roles(membership_id, role_id)
device_groups(id, tenant_id, name, match_rules jsonb, parent_id) -- dynamic or manual
device_group_members(device_group_id, device_id)
grants(id, tenant_id, subject_type, subject_id, permission,
       scope_type, scope_id, granted_by, expires_at)             -- fine-grained overrides
remote_policies(id, tenant_id, device_group_id, allowed_session_types[],
                require_reason, require_mfa_stepup, require_manager_approval,
                recording_mode, consent_mode)                     -- per-group zero-trust policy
```

## 3. Directory

```sql
contacts(id, tenant_id, type, name, email, phone, department, site,
         manager_id, is_vip, account_status, ext_identity jsonb)  -- end-users & requesters
contact_devices(contact_id, device_id, relation)                  -- primary|shared

-- On-prem Active Directory (LDAP/ADSI) integration:
ad_connections(id, tenant_id, name, host, port, use_ssl, base_dn, bind_dn,
               bind_password_enc, enabled, created_by)            -- encrypted bind creds
ad_sync_runs(id, tenant_id, connection_id, status, fetched, created, updated, error)
ad_actions(id, tenant_id, connection_id, actor_id, action, target_upn, status, detail)
```

## 4. Ticketing

```sql
tickets(id, tenant_id, number, type, status, priority, impact, urgency,
        subject, requester_id, affected_user_id, device_id, service_id,
        category_id, assignee_id, team_id, sla_policy_id, source,
        tags[], followers[], due_response_at, due_resolution_at,
        sla_paused_at, resolved_at, closed_at, csat_score, ext jsonb)
ticket_types: incident | service_request | question | problem | change | major_incident

ticket_threads(id, ticket_id, author_id, kind, body_html, body_text,
               visibility, attachments jsonb, created_at)
   -- kind: message | internal_note | system_event | session_record | ai_summary
   -- visibility: public | internal

ticket_links(id, ticket_id, link_type, target_type, target_id)
   -- link_type: parent|child|related|caused_by|duplicates; target: ticket|asset|kb|session
ticket_tasks(id, ticket_id, title, assignee_id, due_at, completed_at)
ticket_approvals(id, ticket_id, approver_id, status, decided_at, note)
time_entries(id, ticket_id, user_id, minutes, note, started_at)

sla_policies(id, tenant_id, name, business_hours_id, matrix jsonb)
   -- matrix: priority → {response_mins, resolution_mins, escalation_steps[]}
categories(id, tenant_id, parent_id, name)                       -- category/subcategory
services(id, tenant_id, name, description, sla_policy_id)
ticket_activity(ticket_id, actor_id, action, field, old, new, at) -- denormalised timeline
```

## 5. Devices & telemetry

```sql
devices(id, tenant_id, name, kind, os, os_version, agent_version, agent_id_ref,
        cert_fp, primary_user_id, device_group_ids[], status, first_seen_at,
        last_seen_at, ext jsonb)
   -- status: pending|active|quarantined|retired
device_inventory(id, device_id, captured_at, hardware jsonb, software jsonb,
                 security jsonb, network jsonb)                   -- versioned snapshots
device_metrics(id, device_id, at, cpu, ram_used, disk jsonb, net jsonb) -- rolling, partitioned
device_alerts(id, tenant_id, device_id, rule_id, state, payload jsonb,
              ticket_id, raised_at, cleared_at)
alert_rules(id, tenant_id, name, metric, condition jsonb, action jsonb)
```

## 6. Remote sessions

```sql
sessions(id, tenant_id, ticket_id, device_id, session_type, state,
         consent jsonb, reason, requested_perms[], granted_perms[],
         recording_mode, quality jsonb, started_at, ended_at, resume_token_hash)
   -- type: attended|unattended|inspection
   -- state: requested→consent_pending→connecting→active→reconnecting→ended|denied|expired
session_participants(id, session_id, user_id, role, joined_at, left_at)
   -- role: owner|invited|observer
session_events(id, session_id, actor_id, kind, payload jsonb, at)
   -- kind: command|script_run|file_op|service_op|process_op|clipboard|reboot|
   --       elevation|invite|transfer|consent_change|quality_change
session_recordings(id, session_id, storage_key, hash, duration, mode, access_policy)
join_tickets(id, session_id, subject_type, subject_id, ticket_hash,
             used_at, expires_at)                                 -- single-use join tokens
```

## 7. Assets (P2, schema reserved)

```sql
assets(id, tenant_id, tag, type, name, status, owner_id, location, supplier,
       warranty_until, purchase jsonb, device_id, ext jsonb)
licences(id, tenant_id, asset_id, key_ref, seats_used, seats_total, expires_at)
```

## 8. Knowledge

```sql
kb_articles(id, tenant_id, title, body, folder_id, visibility, status,
            author_id, version, review_due_at, tags[], embedding vector(1536))
   -- visibility: internal|portal|public; status: draft|review|published|archived
kb_folders(id, tenant_id, name, parent_id, visibility)
kb_feedback(id, article_id, user_id, helpful, comment, at)
```

## 9. Automation & scripts (P2 core)

```sql
automations(id, tenant_id, name, trigger, conditions jsonb, actions jsonb,
            enabled, last_run_at, run_count)
automation_runs(id, automation_id, subject_type, subject_id, status, log jsonb, at)
scripts(id, tenant_id, name, category, os[], version, approval_status,
        body_ref, args_schema jsonb, privilege_level, created_by, approved_by)
script_runs(id, script_id, device_id, session_id, actor_id, args jsonb,
            exit_code, output_ref, started_at, ended_at)
```

## 10. Audit & notifications

```sql
audit_logs(id, tenant_id, at, actor_type, actor_id, action, object_type,
           object_id, ip, ua, payload jsonb, prev_hash, entry_hash)
   -- append-only; hash chain: entry_hash = H(prev_hash || canonical(entry))
notifications(id, tenant_id, user_id, kind, subject_ref, body, read_at,
              channels jsonb, created_at)
webhook_endpoints(id, tenant_id, url, secret_enc, events[], enabled)
webhook_deliveries(id, endpoint_id, event_id, status, attempts, at)
```

## 11. Design notes

- **Event sourcing lite:** tickets, sessions, and devices keep authoritative state tables *plus* event tables (activity/session_events/inventory snapshots). Read models for reporting are built from events.
- **Partitioning:** `device_metrics`, `session_events`, `audit_logs` partitioned monthly; retention per tenant policy.
- **Search:** GIN indexes on `tickets(subject, tags)` + tsvector columns; KB uses tsvector + pgvector for hybrid semantic search (P2 AI features).
- **SLA engine:** deadline columns materialised on tickets; a scheduler re-evaluates against business hours and emits `sla.breached` events; pause/resume transitions logged.
- **Multi-tenant test invariant:** every repository test suite includes a cross-tenant denial case (see testing requirements).
