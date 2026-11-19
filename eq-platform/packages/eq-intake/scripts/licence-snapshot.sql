-- Licence compare: read-only snapshot of the worker's own record (jvkn).
-- SELECT only. Run against jvkn (eq-canonical control plane) with a read-only role,
-- by a person who already has that access. Intake itself has no jvkn connection.
-- Save the single JSON result as snapshot.json. The result holds worker emails:
-- keep it local, do not commit it.
--   :emails   array of the (lower-case) emails that appear in the CSV
-- Output tuples (the runner's compact format):
--   workers   [user_id, email]
--   licences  [id, user_id, licence_type, licence_number, expiry_date, never_expires]
-- Same visibility rules the Shell staff page uses: not deleted, not private.
with params as (
  select (:emails)::text[] as emails
),
w as (
  select user_id, email
  from public.workers, params
  where lower(trim(email)) = any (params.emails)
    and user_id is not null
)
select jsonb_build_object(
  'workers',
    (select coalesce(jsonb_agg(jsonb_build_array(user_id::text, lower(trim(email)))), '[]') from w),
  'licences',
    (select coalesce(jsonb_agg(jsonb_build_array(l.id::text, l.user_id::text, l.licence_type, l.licence_number, l.expiry_date, l.never_expires)), '[]')
       from public.licences l
       join w on w.user_id = l.user_id
      where l.deleted_at is null
        and l.is_private = false)
) as snapshot;
