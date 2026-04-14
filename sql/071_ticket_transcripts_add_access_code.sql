-- Add access_code column to ticket_transcripts table to allow auto-access from dashboard
alter table public.ticket_transcripts 
add column if not exists access_code text;

-- Add a comment for clarity
comment on column public.ticket_transcripts.access_code is 'Plain text access code for the transcript, used for auto-access from the dashboard.';
