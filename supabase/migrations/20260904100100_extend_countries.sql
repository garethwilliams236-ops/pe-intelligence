-- =====================================================================
-- pe-intelligence :: 0012 extend the country reference
--
-- WP1 seeded only the in-scope markets. Real investor lists carry houses
-- headquartered well outside them, and a foreign HQ is a fact worth
-- keeping rather than discarding — a Boston fund with a London office
-- still buys UK assets. in_scope stays false for these: it controls what
-- the crawler covers, not what the database will accept.
-- =====================================================================

insert into public.countries (code, name, region, currency, in_scope) values
  -- rest of Europe
  ('PL','Poland','Central & Eastern Europe','PLN',false),
  ('CZ','Czechia','Central & Eastern Europe','CZK',false),
  ('SK','Slovakia','Central & Eastern Europe','EUR',false),
  ('HU','Hungary','Central & Eastern Europe','HUF',false),
  ('RO','Romania','Central & Eastern Europe','RON',false),
  ('BG','Bulgaria','Central & Eastern Europe','BGN',false),
  ('HR','Croatia','Central & Eastern Europe','EUR',false),
  ('SI','Slovenia','Central & Eastern Europe','EUR',false),
  ('EE','Estonia','Baltics','EUR',false),
  ('LV','Latvia','Baltics','EUR',false),
  ('LT','Lithuania','Baltics','EUR',false),
  ('GR','Greece','Southern Europe','EUR',false),
  ('CY','Cyprus','Southern Europe','EUR',false),
  ('MT','Malta','Southern Europe','EUR',false),
  ('TR','Turkey','Southern Europe','TRY',false),
  ('UA','Ukraine','Central & Eastern Europe','UAH',false),
  -- global financial centres that show up in sponsor HQ fields
  ('IL','Israel','Middle East','ILS',false),
  ('AE','United Arab Emirates','Middle East','AED',false),
  ('SA','Saudi Arabia','Middle East','SAR',false),
  ('QA','Qatar','Middle East','QAR',false),
  ('SG','Singapore','Asia Pacific','SGD',false),
  ('HK','Hong Kong','Asia Pacific','HKD',false),
  ('JP','Japan','Asia Pacific','JPY',false),
  ('CN','China','Asia Pacific','CNY',false),
  ('IN','India','Asia Pacific','INR',false),
  ('KR','South Korea','Asia Pacific','KRW',false),
  ('AU','Australia','Asia Pacific','AUD',false),
  ('NZ','New Zealand','Asia Pacific','NZD',false),
  ('ZA','South Africa','Africa','ZAR',false),
  ('BR','Brazil','Latin America','BRL',false),
  ('MX','Mexico','Latin America','MXN',false),
  ('KY','Cayman Islands','Offshore','USD',false),
  ('JE','Jersey','Offshore','GBP',false),
  ('GG','Guernsey','Offshore','GBP',false),
  ('IM','Isle of Man','Offshore','GBP',false)
on conflict (code) do nothing;
