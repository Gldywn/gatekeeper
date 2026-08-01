-- Gatekeeper local test database (PostgreSQL). Synthetic data only, never anything real.
-- Exercises PII detection (email, full_name, phone), client-data detection (company_name,
-- annual_revenue), sensitive-value literals, joins, and SELECT * expansion.
SET client_min_messages = warning;

CREATE TABLE companies (
  id             SERIAL PRIMARY KEY,
  company_name   TEXT NOT NULL,
  industry       TEXT,
  country        TEXT,
  annual_revenue NUMERIC(14, 2),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  full_name  TEXT NOT NULL,
  phone      TEXT,
  company_id INTEGER REFERENCES companies (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id           SERIAL PRIMARY KEY,
  sku          TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  price        NUMERIC(10, 2) NOT NULL
);

CREATE TABLE orders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id),
  status     TEXT NOT NULL,
  total      NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity   INTEGER NOT NULL,
  unit_price NUMERIC(10, 2) NOT NULL
);

INSERT INTO companies (company_name, industry, country, annual_revenue) VALUES
  ('Acme Corp', 'Manufacturing', 'US', 12500000.00),
  ('Globex', 'Energy', 'US', 48000000.00),
  ('Initech', 'Software', 'US', 8900000.00),
  ('Umbrella Group', 'Pharmaceuticals', 'UK', 156000000.00),
  ('Hooli', 'Software', 'US', 220000000.00),
  ('Wonka Industries', 'Food', 'US', 34000000.00),
  ('Stark Solutions', 'Aerospace', 'US', 512000000.00),
  ('Wayne Enterprises', 'Conglomerate', 'US', 780000000.00);

INSERT INTO users (email, full_name, phone, company_id) VALUES
  ('alice@example.com', 'Alice Martin', '+1-202-555-0142', 1),
  ('bob@example.com', 'Bob Ferreira', '+1-202-555-0173', 1),
  ('carol@example.org', 'Carol Ndiaye', '+44-20-7946-0991', 4),
  ('david@example.com', 'David Okafor', '+1-415-555-0128', 3),
  ('emma@example.net', 'Emma Rossi', '+39-06-555-0110', 2),
  ('frank@example.com', 'Frank Zhao', '+1-415-555-0199', 5),
  ('grace@example.com', 'Grace Kim', '+1-206-555-0155', 5),
  ('hugo@example.org', 'Hugo Bernard', '+33-1-5555-0134', 6),
  ('iris@example.com', 'Iris Nowak', '+48-22-555-0187', 2),
  ('jack@example.com', 'Jack Thompson', '+1-312-555-0166', 7),
  ('kaya@example.net', 'Kaya Yilmaz', '+90-212-555-0143', 8),
  ('liam@example.com', 'Liam OBrien', '+353-1-555-0120', 3),
  ('mia@example.com', 'Mia Andersson', '+46-8-555-0177', 8),
  ('noah@example.org', 'Noah Haddad', '+1-646-555-0188', 7);

INSERT INTO products (sku, product_name, price) VALUES
  ('SKU-1001', 'Standard Widget', 19.99),
  ('SKU-1002', 'Deluxe Widget', 39.99),
  ('SKU-1003', 'Gadget Mini', 12.50),
  ('SKU-1004', 'Gadget Pro', 89.00),
  ('SKU-1005', 'Cable Pack', 7.99),
  ('SKU-1006', 'Power Adapter', 24.99),
  ('SKU-1007', 'Carry Case', 34.50),
  ('SKU-1008', 'Spare Kit', 15.00),
  ('SKU-1009', 'Premium Bundle', 149.00),
  ('SKU-1010', 'Starter Bundle', 59.00);

INSERT INTO orders (user_id, status, total) VALUES
  (1, 'paid', 79.97),
  (3, 'paid', 149.00),
  (5, 'pending', 24.99),
  (2, 'refunded', 39.99),
  (7, 'paid', 103.50),
  (4, 'paid', 12.50),
  (10, 'shipped', 178.00),
  (6, 'cancelled', 59.00),
  (12, 'paid', 44.98),
  (8, 'pending', 89.00),
  (13, 'paid', 233.99),
  (9, 'paid', 15.00);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 2, 19.99),
  (1, 2, 1, 39.99),
  (2, 9, 1, 149.00),
  (3, 6, 1, 24.99),
  (4, 2, 1, 39.99),
  (5, 7, 3, 34.50),
  (6, 3, 1, 12.50),
  (7, 4, 2, 89.00),
  (8, 10, 1, 59.00),
  (9, 1, 1, 19.99),
  (9, 6, 1, 24.99),
  (10, 4, 1, 89.00),
  (11, 9, 1, 149.00),
  (11, 2, 1, 39.99),
  (11, 8, 3, 15.00),
  (12, 8, 1, 15.00);
