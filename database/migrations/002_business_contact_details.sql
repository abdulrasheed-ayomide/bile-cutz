-- Set the confirmed public business details without changing user accounts.
-- Preserve a real contact phone; clear only the schema's known placeholder value.
INSERT INTO business_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

UPDATE business_settings SET
  contact_phone = CASE WHEN contact_phone = '+234 000 000 0000' THEN '' ELSE contact_phone END,
  whatsapp_number = CASE WHEN whatsapp_number = '+234 000 000 0000' THEN '09162231321' ELSE whatsapp_number END,
  contact_email = CASE WHEN contact_email = 'hello@example.com' THEN 'femmanuel628@gmail.com' ELSE contact_email END,
  address = CASE
    WHEN address = 'Your shop address (placeholder — edit in Admin → Settings)' THEN E'49 Ripple Road, Barking\nIG11 7NT'
    ELSE address
  END
WHERE id = 1;