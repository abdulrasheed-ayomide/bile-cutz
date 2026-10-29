-- OPTIONAL demonstration data. Names, prices and durations are SAMPLE values — edit or deactivate
-- them in Admin → Services. Run with `npm run db:seed:demo`. Skips if any service already exists.
INSERT INTO services (name, description, price, duration_minutes, is_active, is_featured, sort_order)
SELECT * FROM (VALUES
  ('Classic Haircut',  'A clean, tailored cut finished with a sharp line-up.',            3000.00, 30, true, true, 1),
  ('Skin Fade',        'Seamless skin fade blended to your preferred length on top.',      4000.00, 45, true, true, 2),
  ('Beard Trim & Shape','Beard sculpting with hot towel finish.',                          2000.00, 20, true, true, 3),
  ('Haircut & Beard',  'Full haircut combined with a beard trim and shape-up.',            5000.00, 60, true, true, 4),
  ('Kids Haircut',     'Gentle, patient cuts for children under 12.',                      2500.00, 30, true, false, 5),
  ('Hair Dye / Colour','Colour application with a quick finish cut.',                     8000.00, 90, true, false, 6)
) AS v(name, description, price, duration_minutes, is_active, is_featured, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM services);
