-- Timesheet reconcile write plan: read-only snapshot of the existing timesheet rows.
-- SELECT only. Run on the tenant plane (ehow for SKS) with a read-only role, save the single JSON
-- result as existing.json outside the repo. Needs the same people list and dates as timesheet-snapshot.sql.
--   :names      array of person names exactly as printed on the PDFs
--   :from, :to  ISO dates (date range of the PDFs, inclusive)
-- Output tuples: [staff_id, date, task, hours, status, timesheet_id]
-- Table: app_data.timesheets (unique key staff_id, date, task; status draft|submitted|approved|rejected|paid).
-- Includes every status, so the plan can skip approved/paid/rejected rows instead of overwriting them.
with params as (
  select (:names)::text[] as names, (:from)::date as d_from, (:to)::date as d_to
),
ppl as (
  select p.id, p.name
  from app_data.field_people p, params
  where lower(trim(p.name)) = any (select lower(trim(x)) from unnest(params.names) x)
)
select coalesce(jsonb_agg(jsonb_build_array(t.staff_id::text, t.date, t.task, t.hours, t.status, t.timesheet_id::text)
                          order by t.staff_id, t.date, t.task), '[]') as existing
from app_data.timesheets t
join ppl on ppl.id::text = t.staff_id::text, params
where t.date between params.d_from and params.d_to;
