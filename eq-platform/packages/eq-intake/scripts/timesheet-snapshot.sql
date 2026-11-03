-- Timesheet reconcile: read-only snapshot of Field for the runner.
-- SELECT only. Run against the tenant plane (ehow for SKS) with a read-only role.
-- Replace the placeholders, run, and save the single JSON result as snapshot.json.
--   :names      array of person names exactly as printed on the PDFs
--   :from, :to  ISO dates (date range of the PDFs, inclusive)
-- Output tuples (the runner's compact format):
--   people     [ix, id, name]
--   timesheets [person_id, date, hours, task]        first slot = people id (the runner joins on it)
--   roster     [person_id, date, task, leave_type]
--   leave      [person_id, requester_name, leave_type, date_start, date_end, hours_requested, status]
-- Names missing from field_people do not appear (the report lists them as not in Field).
-- Matching is case-insensitive on trimmed names; adjust if Field stores them differently.
with params as (
  select (:names)::text[] as names, (:from)::date as d_from, (:to)::date as d_to
),
ppl as (
  select row_number() over (order by p.name) as ix, p.id, p.name
  from app_data.field_people p, params
  where lower(trim(p.name)) = any (select lower(trim(x)) from unnest(params.names) x)
)
select jsonb_build_object(
  'people',
    (select coalesce(jsonb_agg(jsonb_build_array(ix, id::text, name) order by ix), '[]') from ppl),
  'timesheets',
    (select coalesce(jsonb_agg(jsonb_build_array(ppl.id::text, t.date, t.hours, t.task) order by ppl.name, t.date), '[]')
       from app_data.field_timesheets t
       join ppl on ppl.id::text = t.staff_id::text, params
      where t.date between params.d_from and params.d_to),
  'roster',
    (select coalesce(jsonb_agg(jsonb_build_array(ppl.id::text, s.date, s.task, s.leave_type) order by ppl.name, s.date), '[]')
       from app_data.field_schedule s
       join ppl on ppl.id::text = s.person_id::text, params
      where s.date between params.d_from and params.d_to),
  'leave',
    (select coalesce(jsonb_agg(jsonb_build_array(ppl.id::text, l.requester_name, l.leave_type, l.date_start, l.date_end, l.hours_requested, l.status)
                               order by ppl.name, l.date_start), '[]')
       from app_data.field_leave_requests l
       join ppl on ppl.id::text = l.staff_id::text
                or lower(trim(l.requester_name)) = lower(trim(ppl.name)), params
      where coalesce(l.archived, false) = false
        and l.date_start <= params.d_to and l.date_end >= params.d_from)
) as snapshot;
