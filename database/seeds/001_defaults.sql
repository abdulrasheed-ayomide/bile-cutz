-- Safe, idempotent defaults. Run with `npm run db:seed` (never overwrites existing edits).
INSERT INTO business_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO opening_hours (day_of_week, is_open, open_time, close_time) VALUES
  (0, false, '10:00', '16:00'),
  (1, true,  '09:00', '19:00'),
  (2, true,  '09:00', '19:00'),
  (3, true,  '09:00', '19:00'),
  (4, true,  '09:00', '19:00'),
  (5, true,  '09:00', '19:00'),
  (6, true,  '09:00', '19:00')
ON CONFLICT (day_of_week) DO NOTHING;

INSERT INTO faqs (question, answer, sort_order)
SELECT q, a, o FROM (VALUES
  ('How do I book an appointment?', 'Choose a service, pick a date and an available time, enter your details and submit. You do not need an account. The shop will approve your request and you will see the status update.', 1),
  ('Do I have to pay online?', 'No. Payment is made at the shop after your service.', 2),
  ('Can I cancel or reschedule?', 'You can cancel from your account or your private booking link before the cancellation deadline shown in our policy. To reschedule, cancel and book a new time.', 3),
  ('Can I choose a particular barber?', 'Not online. Our team works together and we assign the next available barber when you arrive.', 4),
  ('What if I am running late?', 'Please message us on WhatsApp or through the in-site chat so we can adjust where possible.', 5)
) AS v(q, a, o)
WHERE NOT EXISTS (SELECT 1 FROM faqs);
