CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'attendant')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_profile (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  business_name TEXT NOT NULL DEFAULT 'Essuman''s Cold Store',
  business_address TEXT,
  business_phone TEXT,
  business_email TEXT,
  logo_url TEXT,
  receipt_footer TEXT NOT NULL DEFAULT 'Thank you for shopping with us.',
  receipt_qr_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  currency_code CHAR(3) NOT NULL DEFAULT 'GHS',
  time_zone TEXT NOT NULL DEFAULT 'Africa/Accra',
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO business_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS business_address TEXT;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS business_phone TEXT;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS business_email TEXT;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS receipt_footer TEXT NOT NULL DEFAULT 'Thank you for shopping with us.';
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS receipt_qr_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS product_categories (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED UNIQUE,
  parent_category_id BIGINT REFERENCES product_categories(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS measurement_units (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED UNIQUE,
  symbol TEXT NOT NULL,
  decimal_places SMALLINT NOT NULL DEFAULT 0 CHECK (decimal_places BETWEEN 0 AND 3),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO measurement_units (name, symbol, decimal_places) VALUES
  ('carton', 'ctn', 0), ('piece', 'pc', 0), ('kg', 'kg', 3), ('g', 'g', 0),
  ('pack', 'pack', 0), ('tub', 'tub', 0), ('bag', 'bag', 0), ('box', 'box', 0), ('litre', 'L', 3)
ON CONFLICT (normalized_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  cost_price NUMERIC(12, 2) NOT NULL CHECK (cost_price >= 0),
  selling_price NUMERIC(12, 2) NOT NULL CHECK (selling_price >= 0),
  kilo_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (kilo_price >= 0),
  kg_per_carton NUMERIC(12, 3) NOT NULL DEFAULT 1 CHECK (kg_per_carton > 0),
  minimum_stock NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  current_stock NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES product_categories(id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_id BIGINT REFERENCES measurement_units(id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS kilo_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (kilo_price >= 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS kg_per_carton NUMERIC(12, 3) NOT NULL DEFAULT 1 CHECK (kg_per_carton > 0);
UPDATE products SET kilo_price = selling_price WHERE kilo_price = 0;

INSERT INTO product_categories (name)
SELECT DISTINCT COALESCE(NULLIF(btrim(category), ''), 'Uncategorized') FROM products
ON CONFLICT (normalized_name) DO NOTHING;
INSERT INTO measurement_units (name, symbol, decimal_places)
SELECT DISTINCT COALESCE(NULLIF(btrim(unit), ''), 'piece'), COALESCE(NULLIF(btrim(unit), ''), 'piece'), 3 FROM products
ON CONFLICT (normalized_name) DO NOTHING;

UPDATE products AS product
SET category_id = category.id
FROM product_categories AS category
WHERE product.category_id IS NULL
  AND category.normalized_name = lower(COALESCE(NULLIF(btrim(product.category), ''), 'Uncategorized'));

UPDATE products AS product
SET unit_id = unit.id
FROM measurement_units AS unit
WHERE product.unit_id IS NULL
  AND unit.normalized_name = lower(COALESCE(NULLIF(btrim(product.unit), ''), 'piece'));

ALTER TABLE products ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE products ALTER COLUMN unit_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category);
CREATE INDEX IF NOT EXISTS products_active_idx ON products (active);
CREATE INDEX IF NOT EXISTS products_category_id_idx ON products (category_id);
CREATE INDEX IF NOT EXISTS products_unit_id_idx ON products (unit_id);

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED UNIQUE,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id BIGSERIAL PRIMARY KEY,
  receipt_number TEXT UNIQUE,
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  received_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  supplier_invoice TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'voided')),
  total_cost NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  note TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  voided_at TIMESTAMPTZ,
  void_reason TEXT
);

CREATE INDEX IF NOT EXISTS purchase_receipts_supplier_date_idx ON purchase_receipts (supplier_id, received_at DESC);
CREATE INDEX IF NOT EXISTS purchase_receipts_date_idx ON purchase_receipts (received_at DESC);

CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id BIGSERIAL PRIMARY KEY,
  purchase_receipt_id BIGINT NOT NULL REFERENCES purchase_receipts(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(12, 2) NOT NULL CHECK (unit_cost >= 0),
  line_total NUMERIC(14, 2) NOT NULL CHECK (line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS purchase_receipt_items_receipt_idx ON purchase_receipt_items (purchase_receipt_id);
CREATE INDEX IF NOT EXISTS purchase_receipt_items_product_idx ON purchase_receipt_items (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('received', 'adjustment')),
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity <> 0),
  unit_cost NUMERIC(12, 2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  supplier TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_movements_product_date_idx ON stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_date_idx ON stock_movements (created_at DESC);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS supplier_id BIGINT REFERENCES suppliers(id) ON DELETE RESTRICT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS purchase_receipt_item_id BIGINT REFERENCES purchase_receipt_items(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  receipt_number TEXT UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'momo', 'other')),
  subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
  discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  change_due NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (change_due >= 0),
  total_profit NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reversed')),
  reversed_by BIGINT REFERENCES users(id),
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS change_due NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (change_due >= 0);
UPDATE sales SET total_amount = subtotal, amount_paid = subtotal WHERE total_amount = 0 AND subtotal > 0 AND discount_amount = 0 AND amount_paid = 0 AND change_due = 0;
CREATE OR REPLACE FUNCTION populate_sale_receipt_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.total_amount = 0 AND NEW.subtotal > NEW.discount_amount THEN
    NEW.total_amount := NEW.subtotal - NEW.discount_amount;
  END IF;
  IF NEW.amount_paid = 0 AND NEW.total_amount > 0 THEN
    NEW.amount_paid := NEW.total_amount;
  END IF;
  IF NEW.change_due = 0 AND NEW.amount_paid > NEW.total_amount THEN
    NEW.change_due := NEW.amount_paid - NEW.total_amount;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_populate_receipt_totals ON sales;
CREATE TRIGGER sales_populate_receipt_totals
BEFORE INSERT ON sales
FOR EACH ROW EXECUTE FUNCTION populate_sale_receipt_totals();

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_discount_not_over_subtotal_check;
ALTER TABLE sales ADD CONSTRAINT sales_discount_not_over_subtotal_check CHECK (discount_amount <= subtotal);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_total_matches_discount_check;
ALTER TABLE sales ADD CONSTRAINT sales_total_matches_discount_check CHECK (total_amount = subtotal - discount_amount);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_paid_covers_total_check;
ALTER TABLE sales ADD CONSTRAINT sales_paid_covers_total_check CHECK (amount_paid >= total_amount);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_change_matches_payment_check;
ALTER TABLE sales ADD CONSTRAINT sales_change_matches_payment_check CHECK (change_due = amount_paid - total_amount);
CREATE INDEX IF NOT EXISTS sales_receipt_number_idx ON sales (receipt_number);

CREATE TABLE IF NOT EXISTS sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL REFERENCES sales(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  sale_unit TEXT NOT NULL DEFAULT 'carton' CHECK (sale_unit IN ('carton', 'kg')),
  stock_quantity NUMERIC(12, 3) NOT NULL DEFAULT 1 CHECK (stock_quantity > 0),
  unit_selling_price NUMERIC(12, 2) NOT NULL CHECK (unit_selling_price >= 0),
  unit_cost_price NUMERIC(12, 2) NOT NULL CHECK (unit_cost_price >= 0),
  line_subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (line_subtotal >= 0),
  line_discount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0),
  line_profit NUMERIC(12, 2) NOT NULL
);

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS line_subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (line_subtotal >= 0);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS line_discount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (line_discount >= 0);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS sale_unit TEXT NOT NULL DEFAULT 'carton' CHECK (sale_unit IN ('carton', 'kg'));
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS stock_quantity NUMERIC(12, 3) NOT NULL DEFAULT 1 CHECK (stock_quantity > 0);
UPDATE sale_items SET stock_quantity = quantity WHERE stock_quantity = 1 AND quantity <> 1;
UPDATE sale_items SET line_subtotal = line_total WHERE line_subtotal = 0 AND line_total > 0;

CREATE INDEX IF NOT EXISTS sales_created_at_idx ON sales (created_at DESC);
CREATE INDEX IF NOT EXISTS sales_user_date_idx ON sales (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items (sale_id);

CREATE TABLE IF NOT EXISTS income_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN ('delivery_charge', 'miscellaneous', 'other')),
  description TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'momo', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ,
  voided_by BIGINT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS income_entries_user_date_idx ON income_entries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN ('electricity', 'water', 'transport', 'fuel', 'repairs', 'maintenance', 'salaries', 'rent', 'packaging', 'other')),
  description TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'momo', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ,
  voided_by BIGINT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS expenses_user_date_idx ON expenses (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cash_closures (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  business_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_sales NUMERIC(12, 2) NOT NULL,
  cash_sales NUMERIC(12, 2) NOT NULL,
  momo_sales NUMERIC(12, 2) NOT NULL,
  other_sales NUMERIC(12, 2) NOT NULL,
  other_income NUMERIC(12, 2) NOT NULL,
  cash_income NUMERIC(12, 2) NOT NULL,
  expenses NUMERIC(12, 2) NOT NULL,
  cash_expenses NUMERIC(12, 2) NOT NULL,
  expected_cash NUMERIC(12, 2) NOT NULL,
  actual_cash NUMERIC(12, 2) NOT NULL CHECK (actual_cash >= 0),
  difference NUMERIC(12, 2) NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, business_date)
);

CREATE INDEX IF NOT EXISTS cash_closures_date_idx ON cash_closures (business_date DESC);

CREATE TABLE IF NOT EXISTS stock_adjustment_requests (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  reviewed_by BIGINT REFERENCES users(id),
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity <> 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stock_adjustment_requests_status_idx ON stock_adjustment_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS transaction_audit (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  record_type TEXT NOT NULL CHECK (record_type IN ('income', 'expense')),
  record_id BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('corrected', 'voided')),
  before_data JSONB NOT NULL,
  after_data JSONB NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  actor_name_snapshot TEXT NOT NULL,
  actor_role_snapshot TEXT NOT NULL CHECK (actor_role_snapshot IN ('admin', 'attendant', 'system')),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  summary TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  reason TEXT,
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_idx ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_occurred_idx ON audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action, occurred_at DESC);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sale_id BIGINT REFERENCES sales(id);
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN ('received', 'adjustment', 'sale', 'sale_reversal'));

DROP VIEW IF EXISTS report_product_performance CASCADE;
DROP VIEW IF EXISTS report_attendant_sales CASCADE;
DROP VIEW IF EXISTS report_income_by_day CASCADE;
DROP VIEW IF EXISTS report_expenses_by_day CASCADE;
DROP VIEW IF EXISTS report_sales_by_day CASCADE;
DROP VIEW IF EXISTS report_stock_valuation CASCADE;
DROP VIEW IF EXISTS report_purchase_lines CASCADE;
DROP VIEW IF EXISTS report_sale_lines CASCADE;
DROP VIEW IF EXISTS report_cash_flow_summary CASCADE;
DROP VIEW IF EXISTS report_inventory_snapshot CASCADE;

CREATE VIEW report_sale_lines AS
SELECT
  s.id AS sale_id,
  s.receipt_number,
  s.user_id AS attendant_id,
  u.name AS attendant_name,
  s.payment_method,
  s.created_at,
  i.product_id,
  i.product_name,
  i.quantity,
  i.sale_unit,
  i.stock_quantity,
  i.unit_selling_price,
  i.unit_cost_price,
  i.line_total AS sales_amount,
  round(i.quantity * i.unit_cost_price, 2) AS cost_of_goods_sold,
  i.line_profit AS gross_profit
FROM sales s
JOIN sale_items i ON i.sale_id = s.id
JOIN users u ON u.id = s.user_id
WHERE s.status = 'completed';

CREATE VIEW report_purchase_lines AS
SELECT
  r.id AS purchase_receipt_id,
  r.receipt_number,
  r.supplier_id,
  supplier.name AS supplier_name,
  r.received_by,
  receiver.name AS received_by_name,
  r.received_at,
  i.product_id,
  i.product_name,
  i.unit,
  i.quantity,
  i.unit_cost,
  i.line_total AS purchase_amount
FROM purchase_receipts r
JOIN purchase_receipt_items i ON i.purchase_receipt_id = r.id
JOIN suppliers supplier ON supplier.id = r.supplier_id
JOIN users receiver ON receiver.id = r.received_by
WHERE r.status = 'received';

CREATE VIEW report_stock_valuation AS
SELECT
  p.id AS product_id,
  p.name AS product_name,
  category.name AS category,
  unit.name AS unit,
  p.current_stock,
  p.cost_price AS average_unit_cost,
  round(p.current_stock * p.cost_price, 2) AS stock_value,
  p.selling_price,
  p.kilo_price,
  p.kg_per_carton,
  p.minimum_stock,
  p.active,
  p.current_stock <= p.minimum_stock AS is_low_stock
FROM products p
JOIN product_categories category ON category.id = p.category_id
JOIN measurement_units unit ON unit.id = p.unit_id;

CREATE VIEW report_sales_by_day AS
SELECT
  (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date AS business_date,
  COUNT(*) AS sale_count,
  SUM(total_amount) AS total_sales,
  SUM(total_profit) AS gross_profit,
  SUM(total_amount) FILTER (WHERE payment_method = 'cash') AS cash_sales,
  SUM(total_amount) FILTER (WHERE payment_method = 'momo') AS momo_sales,
  SUM(total_amount) FILTER (WHERE payment_method = 'other') AS other_sales
FROM sales
WHERE status = 'completed'
GROUP BY 1;

CREATE VIEW report_expenses_by_day AS
SELECT
  (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date AS business_date,
  category,
  SUM(amount) AS expense_total,
  SUM(amount) FILTER (WHERE payment_method = 'cash') AS cash_expense_total,
  COUNT(*) AS entry_count
FROM expenses
WHERE voided_at IS NULL
GROUP BY 1, category;

CREATE VIEW report_income_by_day AS
SELECT
  (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date AS business_date,
  category,
  SUM(amount) AS income_total,
  SUM(amount) FILTER (WHERE payment_method = 'cash') AS cash_income_total,
  COUNT(*) AS entry_count
FROM income_entries
WHERE voided_at IS NULL
GROUP BY 1, category;

CREATE VIEW report_attendant_sales AS
SELECT
  s.user_id AS attendant_id,
  u.name AS attendant_name,
  (s.created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date AS business_date,
  COUNT(*) AS sale_count,
  SUM(s.total_amount) AS total_sales,
  SUM(s.total_profit) AS gross_profit,
  SUM(s.total_amount) FILTER (WHERE s.payment_method = 'cash') AS cash_sales,
  SUM(s.total_amount) FILTER (WHERE s.payment_method = 'momo') AS momo_sales,
  SUM(s.total_amount) FILTER (WHERE s.payment_method = 'other') AS other_sales
FROM sales s
JOIN users u ON u.id = s.user_id
WHERE s.status = 'completed'
GROUP BY s.user_id, u.name, 3;

CREATE VIEW report_product_performance AS
SELECT
  p.id AS product_id,
  p.name AS product_name,
  category.name AS category,
  unit.name AS unit,
  p.active,
  COALESCE(SUM(lines.quantity), 0) AS units_sold,
  COALESCE(SUM(lines.sales_amount), 0) AS total_sales,
  COALESCE(SUM(lines.cost_of_goods_sold), 0) AS cost_of_goods_sold,
  COALESCE(SUM(lines.gross_profit), 0) AS gross_profit,
  MAX(lines.created_at) AS last_sold_at,
  p.current_stock,
  p.cost_price AS average_unit_cost,
  round(p.current_stock * p.cost_price, 2) AS current_stock_value
FROM products p
JOIN product_categories category ON category.id = p.category_id
JOIN measurement_units unit ON unit.id = p.unit_id
LEFT JOIN report_sale_lines lines ON lines.product_id = p.id
GROUP BY p.id, p.name, category.name, unit.name, p.active, p.current_stock, p.cost_price;
