-- Black Friday 2026 prices from the shared deal list (Checkers Sixty60, Pick n Pay asap!, Makro).
-- Prices are stored in cents. A multi-buy such as "2 for R60" is deal_qty 2, deal_price_cents 6000.
-- For laundry liquid the shelf compares price per litre, so pack_amount is the litres per bottle.

insert into dl.stores (id, name, chain, kind, sort) values
  ('sixty60',  'Checkers Sixty60', 'Checkers',   'Delivery app from Checkers stores', 1),
  ('pnp-asap', 'Pick n Pay asap!', 'Pick n Pay', 'Delivery app from Pick n Pay stores', 2),
  ('makro',    'Makro',            'Makro',      'In store and online', 3)
on conflict (id) do nothing;

insert into dl.products (id, name, unit, default_qty, sort) values
  ('dishwashing-liquid', 'Dishwashing liquid 1.5L', 'item', 1, 10),
  ('dove-body-spray',    'Dove body spray',         'item', 1, 20),
  ('dove-shower-gel',    'Dove shower gel',         'item', 1, 30),
  ('nivea-body-lotion',  'Nivea body lotion',       'item', 1, 40),
  ('toilet-paper-24',    'Toilet paper, 24 pack',   'item', 1, 50),
  ('laundry-liquid',     'Laundry liquid',          'litre', 4, 60),
  ('domestos',           'Domestos',                'item', 2, 70),
  ('handy-andy',         'Handy Andy',              'item', 1, 80),
  ('olive-oil',          'Olive oil',               'item', 1, 90),
  ('toothpaste',         'Colgate toothpaste',      'item', 3, 100),
  ('stasoft',            'Sta-soft',                'item', 3, 110)
on conflict (id) do nothing;

insert into dl.offers (product_id, store_id, brand, deal_text, deal_qty, deal_price_cents, pack_amount, in_stock) values
  ('dishwashing-liquid', 'sixty60',  '',                    '',                              1,  6499, 1, true),
  ('dishwashing-liquid', 'pnp-asap', '',                    '',                              1,  6499, 1, true),
  ('dishwashing-liquid', 'makro',    '',                    '',                              1,  6395, 1, true),

  ('dove-body-spray',    'sixty60',  'Dove',                '',                              1,  4199, 1, true),
  ('dove-body-spray',    'pnp-asap', 'Dove',                '',                              1,  4199, 1, true),
  ('dove-body-spray',    'makro',    'Dove',                '',                              1,  4995, 1, true),

  ('dove-shower-gel',    'sixty60',  'Dove',                '',                              1,  7499, 1, true),
  ('dove-shower-gel',    'pnp-asap', 'Dove',                '',                              1,  6899, 1, true),
  ('dove-shower-gel',    'makro',    'Dove',                '',                              1,  8095, 1, true),

  ('nivea-body-lotion',  'sixty60',  'Nivea',               '',                              1,  5699, 1, true),
  ('nivea-body-lotion',  'pnp-asap', 'Nivea',               '',                              1,  8499, 1, true),
  ('nivea-body-lotion',  'makro',    'Nivea',               '',                              1,  7895, 1, true),

  ('toilet-paper-24',    'sixty60',  'Twin Saver',          '',                              1, 15499, 1, true),
  ('toilet-paper-24',    'pnp-asap', 'Baby Soft',           '',                              1, 21999, 1, true),
  ('toilet-paper-24',    'makro',    'Baby Soft',           '',                              1, 20900, 1, true),

  ('laundry-liquid',     'sixty60',  'OMO 2L',              '2 for R210',                    2, 21000, 2, true),
  ('laundry-liquid',     'pnp-asap', 'Sunlight 3L',         '3L for R139.99',                1, 13999, 3, true),
  ('laundry-liquid',     'makro',    'Comfort 3L',          '3L for R140',                   1, 14000, 3, true),

  ('domestos',           'sixty60',  'Domestos',            '2 for R60',                     2,  6000, 1, true),
  ('domestos',           'pnp-asap', 'Domestos',            '2 for R55',                     2,  5500, 1, true),
  ('domestos',           'makro',    'Domestos',            'Sold out',                      1,  null, 1, false),

  ('handy-andy',         'sixty60',  'Handy Andy',          '',                              1,  2599, 1, true),
  ('handy-andy',         'pnp-asap', 'Handy Andy',          '',                              1,  2999, 1, true),
  ('handy-andy',         'makro',    'Handy Andy',          '',                              1,  2600, 1, true),

  ('olive-oil',          'sixty60',  'Olive Pride',         '',                              1,  8999, 1, true),
  ('olive-oil',          'pnp-asap', 'Olive Pride',         '',                              1,  7499, 1, true),
  ('olive-oil',          'makro',    'Canola Olive',        '',                              1,  7495, 1, true),

  ('toothpaste',         'sixty60',  'Colgate',             'Buy 3, cheapest free (R64.99 each)', 3, 12998, 1, true),
  ('toothpaste',         'pnp-asap', 'Colgate Optic White', '',                              1,  6999, 1, true),
  ('toothpaste',         'makro',    'Colgate Optic White', '',                              1,  9495, 1, true),

  ('stasoft',            'sixty60',  'Sta-soft',            '3 for R94.99',                  3,  9499, 1, true),
  ('stasoft',            'pnp-asap', 'Sta-soft',            '3 for R99.99',                  3,  9999, 1, true),
  ('stasoft',            'makro',    'Sta-soft',            '18 for R729.95',               18, 72995, 1, true)
on conflict (product_id, store_id) do nothing;
