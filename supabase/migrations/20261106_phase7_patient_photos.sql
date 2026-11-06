-- Phase 7 — patient photo storage (profiles.photo_url already exists from Phase 1)
-- Create public-read bucket for patient ID photos (staff upload via authenticated client).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'patient-photos',
  'patient-photos',
  true,
  2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Authenticated staff can upload/update/delete; anyone can read (public bucket for card print).
DROP POLICY IF EXISTS "patient_photos_auth_upload" ON storage.objects;
CREATE POLICY "patient_photos_auth_upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'patient-photos');

DROP POLICY IF EXISTS "patient_photos_auth_update" ON storage.objects;
CREATE POLICY "patient_photos_auth_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'patient-photos');

DROP POLICY IF EXISTS "patient_photos_auth_delete" ON storage.objects;
CREATE POLICY "patient_photos_auth_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'patient-photos');

DROP POLICY IF EXISTS "patient_photos_public_read" ON storage.objects;
CREATE POLICY "patient_photos_public_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'patient-photos');
