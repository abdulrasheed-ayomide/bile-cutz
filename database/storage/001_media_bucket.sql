-- Run once in the Supabase SQL editor (Dashboard → SQL Editor) when STORAGE_PROVIDER=supabase.
-- The bucket is PUBLIC FOR READING (shop photos are shown on the public website) but has NO write
-- policies: anonymous and logged-in Supabase roles cannot upload, change or delete anything. Uploads
-- happen only through the Express API (admins only), which uses the service-role key kept on the server.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('bile-cutz-media', 'bile-cutz-media', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 5242880, allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];
-- Deliberately no INSERT / UPDATE / DELETE policies on storage.objects for this bucket.
