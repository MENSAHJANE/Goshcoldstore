import 'dotenv/config'
import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { allowRoles, createToken, requireAuth } from './auth.js'
import { pool, type AuthenticatedRequest } from './db.js'

const app = express()
const port = Number(process.env.API_PORT || 4000)
const allowedOrigins = new Set((process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://127.0.0.1:4173,http://127.0.0.1:4174').split(',').map((origin) => origin.trim()).filter(Boolean))
if (process.env.NODE_ENV !== 'production') {
  for (const origin of ['http://localhost:4173', 'http://127.0.0.1:4173', 'http://127.0.0.1:4174']) allowedOrigins.add(origin)
}
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.resolve(__dirname, '../dist')

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true)
    return callback(new Error(`Origin ${origin} is not allowed by CORS`))
  },
  credentials: true,
}))
app.use(express.json({ limit: '1mb' }))

const loginSchema = z.object({ email: z.email(), password: z.string().min(1) })
const userSchema = z.object({ name: z.string().trim().min(2), email: z.email(), password: z.string().min(10), role: z.enum(['admin', 'attendant']) })
const userUpdateSchema = z.object({ name: z.string().trim().min(2), email: z.email(), role: z.enum(['admin', 'attendant']) })
const productSchema = z.object({
  name: z.string().trim().min(1), category: z.string().trim().min(1), unit: z.string().trim().min(1),
  costPrice: z.number().nonnegative(), sellingPrice: z.number().nonnegative(), kiloPrice: z.number().nonnegative().default(0), kgPerCarton: z.number().positive().default(1), minimumStock: z.number().nonnegative().default(0),
  currentStock: z.number().nonnegative().default(0), active: z.boolean().default(true),
})
const productUpdateSchema = productSchema.omit({ currentStock: true }).partial().refine((data) => Object.keys(data).length > 0)
const receiptSchema = z.object({ productId: z.coerce.number().int().positive(), quantity: z.number().positive(), unitCost: z.number().nonnegative(), supplier: z.string().trim().min(1), note: z.string().trim().optional() })
const adjustmentSchema = z.object({ productId: z.coerce.number().int().positive(), quantity: z.number().refine((value) => value !== 0), note: z.string().trim().min(1) })
const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10) })
const paymentMethodSchema = z.enum(['cash', 'momo', 'other'])
const saleUnitSchema = z.enum(['carton', 'kg'])
const saleSchema = z.object({ paymentMethod: paymentMethodSchema, discountAmount: z.number().nonnegative().default(0), amountPaid: z.number().nonnegative().optional(), items: z.array(z.object({ productId: z.coerce.number().int().positive(), quantity: z.number().positive(), saleUnit: saleUnitSchema.default('carton') })).min(1).max(100) })
const businessProfileSchema = z.object({ businessName: z.string().trim().min(1).max(160), businessAddress: z.string().trim().max(500).nullable(), businessPhone: z.string().trim().max(80).nullable(), businessEmail: z.email().or(z.literal('')).nullable(), logoUrl: z.url().or(z.literal('')).nullable(), receiptFooter: z.string().trim().max(240), receiptQrEnabled: z.boolean() })
const reversalSchema = z.object({ reason: z.string().trim().min(3).max(500) })
const financeEntrySchema = z.object({ category: z.string().trim().min(1), description: z.string().trim().min(2).max(500), amount: z.number().positive(), paymentMethod: paymentMethodSchema })
const incomeSchema = financeEntrySchema.extend({ category: z.enum(['delivery_charge', 'miscellaneous', 'other']) })
const expenseSchema = financeEntrySchema.extend({ category: z.enum(['electricity', 'water', 'transport', 'fuel', 'repairs', 'maintenance', 'salaries', 'rent', 'packaging', 'other']) })
const cashCloseSchema = z.object({ actualCash: z.number().nonnegative() })
const adjustmentReviewSchema = z.object({ decision: z.enum(['approved', 'rejected']), reviewNote: z.string().trim().max(500).optional() })

const roundMoney = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100
const roundQuantity = (quantity: number) => Math.round((quantity + Number.EPSILON) * 1000) / 1000

async function ensureBusinessDayOpen(client: import('pg').PoolClient, userId: number) {
  await client.query('SELECT pg_advisory_xact_lock(71824033 + $1::bigint)', [userId])
  const closure = await client.query('SELECT 1 FROM cash_closures WHERE user_id = $1 AND business_date = (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date', [userId])
  return !closure.rowCount
}

async function currentBusinessDate(database: Pick<import('pg').Pool, 'query'> | Pick<import('pg').PoolClient, 'query'>) {
  const result = await database.query('SELECT (NOW() AT TIME ZONE time_zone)::date AS business_date FROM business_profile WHERE id = 1')
  return result.rows[0].business_date as string
}

async function ensureProductCategory(client: import('pg').PoolClient, name: string) {
  const result = await client.query('INSERT INTO product_categories (name) VALUES ($1) ON CONFLICT (normalized_name) DO UPDATE SET updated_at = NOW() RETURNING id', [name])
  return Number(result.rows[0].id)
}

async function ensureMeasurementUnit(client: import('pg').PoolClient, name: string) {
  const precision = ['kg', 'litre', 'l'].includes(name.trim().toLowerCase()) ? 3 : 0
  const result = await client.query('INSERT INTO measurement_units (name, symbol, decimal_places) VALUES ($1, $1, $2) ON CONFLICT (normalized_name) DO UPDATE SET active = TRUE RETURNING id', [name, precision])
  return Number(result.rows[0].id)
}

async function dailyTotals(database: Pick<import('pg').Pool, 'query'> | Pick<import('pg').PoolClient, 'query'>, userId: number | null, businessDate: string | null = null) {
  const result = await database.query(`SELECT
    COALESCE((SELECT SUM(total_amount) FROM sales WHERE status = 'completed' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS total_sales,
    COALESCE((SELECT SUM(total_amount) FROM sales WHERE status = 'completed' AND payment_method = 'cash' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS cash_sales,
    COALESCE((SELECT SUM(total_amount) FROM sales WHERE status = 'completed' AND payment_method = 'momo' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS momo_sales,
    COALESCE((SELECT SUM(total_amount) FROM sales WHERE status = 'completed' AND payment_method = 'other' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS other_sales,
    COALESCE((SELECT SUM(amount) FROM income_entries WHERE voided_at IS NULL AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS other_income,
    COALESCE((SELECT SUM(amount) FROM income_entries WHERE voided_at IS NULL AND payment_method = 'cash' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS cash_income,
    COALESCE((SELECT SUM(amount) FROM expenses WHERE voided_at IS NULL AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS expenses,
    COALESCE((SELECT SUM(amount) FROM expenses WHERE voided_at IS NULL AND payment_method = 'cash' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS cash_expenses,
    COALESCE((SELECT SUM(total_profit) FROM sales WHERE status = 'completed' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = COALESCE($2::date, (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date) AND ($1::bigint IS NULL OR user_id = $1)), 0) AS sales_profit
  `, [userId, businessDate])
  const values = result.rows[0]
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)])) as Record<string, number>
}

function validated<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value)
  return result.success ? { data: result.data } : { error: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ') }
}

function asyncRoute(handler: (request: express.Request, response: express.Response) => Promise<unknown>) {
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    void handler(request, response).catch(next)
  }
}

const signedIn = (request: express.Request) => (request as AuthenticatedRequest).user

app.get('/api/health', asyncRoute(async (_request, response) => {
  await pool.query('SELECT 1')
  response.json({ status: 'ok' })
}))

app.get('/api/auth/setup', asyncRoute(async (_request, response) => {
  const result = await pool.query('SELECT EXISTS (SELECT 1 FROM users) AS configured')
  response.json({ needsSetup: !result.rows[0].configured })
}))

app.post('/api/auth/bootstrap', asyncRoute(async (request, response) => {
  const input = validated(userSchema, { ...request.body, role: 'admin' })
  if ('error' in input) return response.status(400).json({ error: input.error })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(71824031)')
    const existing = await client.query('SELECT 1 FROM users LIMIT 1')
    if (existing.rowCount) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'Initial admin setup has already been completed' })
    }
    const passwordHash = await bcrypt.hash(input.data.password, 12)
    const result = await client.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role', [input.data.name, input.data.email.toLowerCase(), passwordHash, 'admin'])
    await client.query('COMMIT')
    const user = result.rows[0]
    response.status(201).json({ user, token: createToken(user) })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}))

app.post('/api/auth/login', asyncRoute(async (request, response) => {
  const input = validated(loginSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const result = await pool.query('SELECT id, name, email, role, password_hash, active FROM users WHERE email = $1', [input.data.email.toLowerCase()])
  const user = result.rows[0]
  if (!user || !user.active || !(await bcrypt.compare(input.data.password, user.password_hash))) return response.status(401).json({ error: 'Email or password is incorrect' })
  const safeUser = { id: Number(user.id), name: user.name, email: user.email, role: user.role }
  response.json({ user: safeUser, token: createToken(safeUser) })
}))

app.get('/api/auth/me', requireAuth, asyncRoute(async (request, response) => {
  const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1 AND active = TRUE', [signedIn(request).id])
  if (!result.rowCount) return response.status(401).json({ error: 'Account is no longer active' })
  response.json({ user: result.rows[0] })
}))

app.get('/api/business-profile', requireAuth, asyncRoute(async (_request, response) => {
  const result = await pool.query('SELECT business_name AS "businessName", business_address AS "businessAddress", business_phone AS "businessPhone", business_email AS "businessEmail", logo_url AS "logoUrl", receipt_footer AS "receiptFooter", receipt_qr_enabled AS "receiptQrEnabled", currency_code AS "currencyCode", time_zone AS "timeZone" FROM business_profile WHERE id = 1')
  response.json({ profile: result.rows[0] })
}))

app.patch('/api/business-profile', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const input = validated(businessProfileSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const actor = signedIn(request)
  const result = await pool.query('UPDATE business_profile SET business_name = $1, business_address = $2, business_phone = $3, business_email = NULLIF($4, \'\'), logo_url = NULLIF($5, \'\'), receipt_footer = $6, receipt_qr_enabled = $7, updated_at = NOW() WHERE id = 1 RETURNING business_name AS "businessName", business_address AS "businessAddress", business_phone AS "businessPhone", business_email AS "businessEmail", logo_url AS "logoUrl", receipt_footer AS "receiptFooter", receipt_qr_enabled AS "receiptQrEnabled", currency_code AS "currencyCode", time_zone AS "timeZone"', [input.data.businessName, input.data.businessAddress, input.data.businessPhone, input.data.businessEmail, input.data.logoUrl, input.data.receiptFooter, input.data.receiptQrEnabled])
  await pool.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'business.receipt_settings_updated\', \'business_profile\', 1, $4, $5)', [actor.id, actor.name, actor.role, `${actor.name} updated receipt business information`, result.rows[0]])
  response.json({ profile: result.rows[0] })
}))

app.patch('/api/auth/password', requireAuth, asyncRoute(async (request, response) => {
  const input = validated(passwordSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const user = signedIn(request)
  const found = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id])
  if (!found.rowCount || !(await bcrypt.compare(input.data.currentPassword, found.rows[0].password_hash))) return response.status(400).json({ error: 'Current password is incorrect' })
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [await bcrypt.hash(input.data.newPassword, 12), user.id])
  response.json({ message: 'Password updated' })
}))

app.get('/api/users', requireAuth, allowRoles('admin'), asyncRoute(async (_request, response) => {
  const users = await pool.query('SELECT id, name, email, role, active, created_at FROM users WHERE deleted_at IS NULL ORDER BY name')
  response.json({ users: users.rows })
}))

app.post('/api/users', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const input = validated(userSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const actor = signedIn(request)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id, name, email, role, active', [input.data.name, input.data.email.toLowerCase(), await bcrypt.hash(input.data.password, 12), input.data.role])
    if (!result.rowCount) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'A user with this email already exists' }) }
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'user.created\', \'user\', $4, $5, $6)', [actor.id, actor.name, actor.role, result.rows[0].id, `${actor.name} created ${input.data.role} account ${input.data.email.toLowerCase()}`, result.rows[0]])
    await client.query('COMMIT')
    response.status(201).json({ user: result.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.patch('/api/users/:id', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || id < 1) return response.status(400).json({ error: 'A valid user id is required' })
  const input = validated(userUpdateSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const actor = signedIn(request)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const before = await client.query('SELECT id, name, email, role, active FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])
    if (!before.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'User not found' }) }
    const target = before.rows[0]
    if (id === actor.id && target.role === 'admin' && input.data.role !== 'admin') {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'You cannot change your own administrator role' })
    }
    if (target.role === 'admin' && target.active && input.data.role !== 'admin') {
      const admins = await client.query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = TRUE AND deleted_at IS NULL")
      if (Number(admins.rows[0].count) <= 1) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'The last active administrator cannot be changed to an attendant' }) }
    }
    const result = await client.query('UPDATE users SET name = $1, email = $2, role = $3, updated_at = NOW() WHERE id = $4 AND deleted_at IS NULL RETURNING id, name, email, role, active', [input.data.name, input.data.email.toLowerCase(), input.data.role, id])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, before_data, after_data) VALUES ($1, $2, $3, \'user.updated\', \'user\', $4, $5, $6, $7)', [actor.id, actor.name, actor.role, id, `${actor.name} updated account ${result.rows[0].email}`, target, result.rows[0]])
    await client.query('COMMIT')
    response.json({ user: result.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23505') return response.status(409).json({ error: 'A user with this email already exists' })
    throw error
  } finally { client.release() }
}))

app.patch('/api/users/:id/password', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || id < 1) return response.status(400).json({ error: 'A valid user id is required' })
  const input = z.object({ password: z.string().min(10) }).safeParse(request.body)
  if (!input.success) return response.status(400).json({ error: 'Password must be at least 10 characters' })
  const actor = signedIn(request)
  const result = await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL RETURNING id, name, email', [await bcrypt.hash(input.data.password, 12), id])
  if (!result.rowCount) return response.status(404).json({ error: 'User not found' })
  await pool.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'user.password_reset\', \'user\', $4, $5, $6)', [actor.id, actor.name, actor.role, id, `${actor.name} reset the password for ${result.rows[0].email}`, { id }])
  response.json({ message: 'User password updated' })
}))

app.delete('/api/users/:id', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  const actor = signedIn(request)
  if (!Number.isInteger(id) || id < 1 || id === actor.id) return response.status(400).json({ error: 'A valid different user id is required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const before = await client.query('SELECT id, name, email, role, active FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])
    if (!before.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'User not found' }) }
    const target = before.rows[0]
    if (target.role === 'admin' && target.active) {
      const admins = await client.query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = TRUE AND deleted_at IS NULL")
      if (Number(admins.rows[0].count) <= 1) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'The last active administrator cannot be deleted' }) }
    }
    await client.query('UPDATE users SET active = FALSE, deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [id])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, before_data) VALUES ($1, $2, $3, \'user.deleted\', \'user\', $4, $5, $6)', [actor.id, actor.name, actor.role, id, `${actor.name} deleted account ${target.email}`, target])
    await client.query('COMMIT')
    response.json({ message: 'User deleted' })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.patch('/api/users/:id/active', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || id < 1 || id === signedIn(request).id) return response.status(400).json({ error: 'A valid different user id is required' })
  const actor = signedIn(request)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query('SELECT id, role, active FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])
    if (!current.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'User not found' }) }
    if (current.rows[0].role === 'admin' && current.rows[0].active) {
      const admins = await client.query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = TRUE AND deleted_at IS NULL")
      if (Number(admins.rows[0].count) <= 1) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'The last active administrator cannot be disabled' }) }
    }
    const result = await client.query('UPDATE users SET active = NOT active, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, email, role, active', [id])
    if (!result.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'User not found' }) }
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'user.status_changed\', \'user\', $4, $5, $6)', [actor.id, actor.name, actor.role, id, `${actor.name} ${result.rows[0].active ? 'enabled' : 'disabled'} user ${result.rows[0].email}`, result.rows[0]])
    await client.query('COMMIT')
    response.json({ user: result.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.get('/api/products', requireAuth, asyncRoute(async (request, response) => {
  const includeInactive = signedIn(request).role === 'admin' && request.query.includeInactive === 'true'
  const products = await pool.query(`SELECT p.id, p.name, category.name AS category, unit.name AS unit, p.cost_price AS "costPrice", p.selling_price AS "sellingPrice", p.kilo_price AS "kiloPrice", p.kg_per_carton AS "kgPerCarton", p.minimum_stock AS "minimumStock", p.current_stock AS "currentStock", p.active, p.created_at AS "createdAt", p.updated_at AS "updatedAt" FROM products p JOIN product_categories category ON category.id = p.category_id JOIN measurement_units unit ON unit.id = p.unit_id ${includeInactive ? '' : 'WHERE p.active = TRUE'} ORDER BY p.name`)
  response.json({ products: products.rows })
}))

app.post('/api/products', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const input = validated(productSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const product = input.data
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const categoryId = await ensureProductCategory(client, product.category)
    const unitId = await ensureMeasurementUnit(client, product.unit)
    const kiloPrice = product.kiloPrice || product.sellingPrice
    const result = await client.query('INSERT INTO products (name, category, unit, category_id, unit_id, cost_price, selling_price, kilo_price, kg_per_carton, minimum_stock, current_stock, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *', [product.name, product.category, product.unit, categoryId, unitId, product.costPrice, product.sellingPrice, kiloPrice, product.kgPerCarton, product.minimumStock, product.currentStock, product.active])
    const created = result.rows[0]
    if (product.currentStock > 0) await client.query('INSERT INTO stock_movements (product_id, user_id, movement_type, quantity, unit_cost, note) VALUES ($1, $2, \'adjustment\', $3, $4, \'Opening stock\')', [created.id, signedIn(request).id, product.currentStock, product.costPrice])
    const actor = signedIn(request)
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'product.created\', \'product\', $4, $5, $6)', [actor.id, actor.name, actor.role, created.id, `${actor.name} created product ${created.name}`, created])
    await client.query('COMMIT')
    response.status(201).json({ product: created })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.patch('/api/products/:id', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  const input = validated(productUpdateSchema, request.body)
  if (!Number.isInteger(id) || id < 1 || 'error' in input) return response.status(400).json({ error: 'Valid product changes are required' })
  const columns: Record<string, string> = { name: 'name', category: 'category', unit: 'unit', costPrice: 'cost_price', sellingPrice: 'selling_price', kiloPrice: 'kilo_price', kgPerCarton: 'kg_per_carton', minimumStock: 'minimum_stock', active: 'active' }
  const entries = Object.entries(input.data).filter(([key]) => key !== 'currentStock')
  if (entries.some(([key]) => !columns[key])) return response.status(400).json({ error: 'Stock changes must use a stock movement endpoint' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const before = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [id])
    if (!before.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Product not found' }) }
    const values: unknown[] = []
    const assignments: string[] = []
    for (const [key, value] of entries) {
      if (key === 'category') {
        values.push(value, await ensureProductCategory(client, String(value)))
        assignments.push(`category = $${values.length - 1}`, `category_id = $${values.length}`)
      } else if (key === 'unit') {
        values.push(value, await ensureMeasurementUnit(client, String(value)))
        assignments.push(`unit = $${values.length - 1}`, `unit_id = $${values.length}`)
      } else {
        values.push(value)
        assignments.push(`${columns[key]} = $${values.length}`)
      }
    }
    assignments.push('updated_at = NOW()')
    const result = await client.query(`UPDATE products SET ${assignments.join(', ')} WHERE id = $${values.length + 1} RETURNING *`, [...values, id])
    const actor = signedIn(request)
    const changedPrice = (input.data.sellingPrice !== undefined && Number(input.data.sellingPrice) !== Number(before.rows[0].selling_price))
      || (input.data.kiloPrice !== undefined && Number(input.data.kiloPrice) !== Number(before.rows[0].kilo_price))
    const action = changedPrice ? 'product.selling_price_changed' : 'product.updated'
    const summary = changedPrice
      ? `${actor.name} changed ${before.rows[0].name} selling price from ${before.rows[0].selling_price} to ${input.data.sellingPrice}`
      : `${actor.name} updated product ${result.rows[0].name}`
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, before_data, after_data) VALUES ($1, $2, $3, $4, \'product\', $5, $6, $7, $8)', [actor.id, actor.name, actor.role, action, id, summary, before.rows[0], result.rows[0]])
    await client.query('COMMIT')
    response.json({ product: result.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.post('/api/stock/receive', requireAuth, asyncRoute(async (request, response) => {
  const input = validated(receiptSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const receipt = input.data
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const product = await client.query('SELECT id, name, unit, current_stock, cost_price FROM products WHERE id = $1 AND active = TRUE FOR UPDATE', [receipt.productId])
    if (!product.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Active product not found' }) }
    const actor = signedIn(request)
    const supplier = await client.query('INSERT INTO suppliers (name) VALUES ($1) ON CONFLICT (normalized_name) DO UPDATE SET updated_at = NOW() RETURNING id, name', [receipt.supplier])
    const purchase = await client.query('INSERT INTO purchase_receipts (supplier_id, received_by, total_cost, note) VALUES ($1, $2, $3, $4) RETURNING id, received_at', [supplier.rows[0].id, actor.id, roundMoney(receipt.quantity * receipt.unitCost), receipt.note ?? null])
    const purchaseId = Number(purchase.rows[0].id)
    const receiptNumber = `PR-${new Date(purchase.rows[0].received_at).toISOString().slice(0, 10).replaceAll('-', '')}-${String(purchaseId).padStart(6, '0')}`
    await client.query('UPDATE purchase_receipts SET receipt_number = $1 WHERE id = $2', [receiptNumber, purchaseId])
    const purchaseItem = await client.query('INSERT INTO purchase_receipt_items (purchase_receipt_id, product_id, product_name, unit, quantity, unit_cost, line_total) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [purchaseId, receipt.productId, product.rows[0].name, product.rows[0].unit, receipt.quantity, receipt.unitCost, roundMoney(receipt.quantity * receipt.unitCost)])
    const oldQuantity = Number(product.rows[0].current_stock)
    const oldCost = Number(product.rows[0].cost_price)
    const averageCost = roundMoney((oldQuantity * oldCost + receipt.quantity * receipt.unitCost) / (oldQuantity + receipt.quantity))
    await client.query('UPDATE products SET current_stock = current_stock + $1, cost_price = $2, updated_at = NOW() WHERE id = $3', [receipt.quantity, averageCost, receipt.productId])
    const movement = await client.query('INSERT INTO stock_movements (product_id, user_id, movement_type, quantity, unit_cost, supplier, supplier_id, purchase_receipt_item_id, note) VALUES ($1, $2, \'received\', $3, $4, $5, $6, $7, $8) RETURNING *', [receipt.productId, actor.id, receipt.quantity, receipt.unitCost, supplier.rows[0].name, supplier.rows[0].id, purchaseItem.rows[0].id, receipt.note ?? `Purchase ${receiptNumber}`])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'stock.goods_received\', \'purchase_receipt\', $4, $5, $6)', [actor.id, actor.name, actor.role, purchaseId, `${actor.name} received ${receipt.quantity} ${product.rows[0].unit} ${product.rows[0].name} from ${supplier.rows[0].name}`, { receiptNumber, supplier: supplier.rows[0].name, productId: receipt.productId, quantity: receipt.quantity, unitCost: receipt.unitCost }])
    await client.query('COMMIT')
    response.status(201).json({ movement: movement.rows[0], purchase: { id: purchaseId, receiptNumber, supplier: supplier.rows[0].name, totalCost: roundMoney(receipt.quantity * receipt.unitCost) } })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.post('/api/stock/adjustments', requireAuth, asyncRoute(async (request, response) => {
  const input = validated(adjustmentSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const adjustment = input.data
  const user = signedIn(request)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ensureBusinessDayOpen(client, user.id))) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'This business day is already closed' }) }
    if (user.role === 'attendant') {
      const product = await client.query('SELECT id FROM products WHERE id = $1 AND active = TRUE', [adjustment.productId])
      if (!product.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Active product not found' }) }
      const pending = await client.query('INSERT INTO stock_adjustment_requests (product_id, requested_by, quantity, reason) VALUES ($1, $2, $3, $4) RETURNING id, status', [adjustment.productId, user.id, adjustment.quantity, adjustment.note])
      await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'stock_adjustment.requested\', \'stock_adjustment_request\', $4, $5, $6)', [user.id, user.name, user.role, pending.rows[0].id, `${user.name} requested stock adjustment for product #${adjustment.productId}`, { productId: adjustment.productId, quantity: adjustment.quantity, reason: adjustment.note }])
      await client.query('COMMIT')
      return response.status(202).json({ request: pending.rows[0], message: 'Adjustment submitted for admin approval' })
    }
    const product = await client.query('SELECT id, current_stock FROM products WHERE id = $1 AND active = TRUE FOR UPDATE', [adjustment.productId])
    if (!product.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Active product not found' }) }
    if (Number(product.rows[0].current_stock) + adjustment.quantity < 0) { await client.query('ROLLBACK'); return response.status(400).json({ error: 'Adjustment would reduce stock below zero' }) }
    await client.query('UPDATE products SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2', [adjustment.quantity, adjustment.productId])
    const movement = await client.query('INSERT INTO stock_movements (product_id, user_id, movement_type, quantity, note) VALUES ($1, $2, \'adjustment\', $3, $4) RETURNING *', [adjustment.productId, signedIn(request).id, adjustment.quantity, adjustment.note])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'stock.adjusted\', \'product\', $4, $5, $6)', [user.id, user.name, user.role, adjustment.productId, `${user.name} adjusted stock for product #${adjustment.productId} by ${adjustment.quantity}`, { quantity: adjustment.quantity, reason: adjustment.note, movementId: movement.rows[0].id }])
    await client.query('COMMIT')
    response.status(201).json({ movement: movement.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.get('/api/stock/low', requireAuth, asyncRoute(async (_request, response) => {
  const result = await pool.query('SELECT id, name, category, unit, current_stock AS "currentStock", minimum_stock AS "minimumStock" FROM products WHERE active = TRUE AND current_stock <= minimum_stock ORDER BY (minimum_stock - current_stock) DESC, name')
  response.json({ products: result.rows })
}))

app.get('/api/stock/history', requireAuth, asyncRoute(async (request, response) => {
  const productId = request.query.productId ? Number(request.query.productId) : null
  if (productId !== null && (!Number.isInteger(productId) || productId < 1)) return response.status(400).json({ error: 'Invalid product id' })
  const result = await pool.query('SELECT m.id, m.product_id AS "productId", p.name AS "productName", m.movement_type AS type, m.quantity, m.unit_cost AS "unitCost", m.supplier, m.note, u.name AS "recordedBy", m.created_at AS "createdAt" FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN users u ON u.id = m.user_id WHERE ($1::bigint IS NULL OR m.product_id = $1) ORDER BY m.created_at DESC LIMIT 200', [productId])
  response.json({ movements: result.rows })
}))

app.post('/api/sales', requireAuth, asyncRoute(async (request, response) => {
  const input = validated(saleSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const lineGroups = new Map<string, { productId: number; quantity: number; saleUnit: 'carton' | 'kg' }>()
  for (const item of input.data.items) {
    const key = `${item.productId}:${item.saleUnit}`
    const current = lineGroups.get(key)
    lineGroups.set(key, { productId: item.productId, saleUnit: item.saleUnit, quantity: (current?.quantity ?? 0) + item.quantity })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const seller = signedIn(request)
    if (!(await ensureBusinessDayOpen(client, seller.id))) {
      await client.query('ROLLBACK')
      return response.status(409).json({ error: 'This business day is already closed' })
    }
    const productIds = [...new Set([...lineGroups.values()].map((item) => item.productId))].sort((left, right) => left - right)
    const locked = await client.query('SELECT id, name, current_stock, cost_price, selling_price, kilo_price, kg_per_carton FROM products WHERE id = ANY($1::bigint[]) AND active = TRUE ORDER BY id FOR UPDATE', [productIds])
    if (locked.rowCount !== productIds.length) {
      await client.query('ROLLBACK')
      return response.status(400).json({ error: 'One or more products are inactive or unavailable' })
    }
    const byId = new Map(locked.rows.map((product) => [Number(product.id), product]))
    const stockNeeded = new Map<number, number>()
    for (const line of lineGroups.values()) {
      const product = byId.get(line.productId)!
      const kgPerCarton = Number(product.kg_per_carton) || 1
      const stockQuantity = line.saleUnit === 'kg' ? roundQuantity(line.quantity / kgPerCarton) : line.quantity
      stockNeeded.set(line.productId, roundQuantity((stockNeeded.get(line.productId) ?? 0) + stockQuantity))
    }
    for (const [id, quantity] of stockNeeded) {
      if (Number(byId.get(id)!.current_stock) < quantity) {
        await client.query('ROLLBACK')
        return response.status(409).json({ error: `Not enough stock for ${byId.get(id)!.name}` })
      }
    }
    const rawLines = [...lineGroups.values()].map((line) => {
      const product = byId.get(line.productId)!
      const kgPerCarton = Number(product.kg_per_carton) || 1
      const unitPrice = line.saleUnit === 'kg' ? Number(product.kilo_price || product.selling_price) : Number(product.selling_price)
      const unitCost = line.saleUnit === 'kg' ? roundMoney(Number(product.cost_price) / kgPerCarton) : Number(product.cost_price)
      const stockQuantity = line.saleUnit === 'kg' ? roundQuantity(line.quantity / kgPerCarton) : line.quantity
      const lineSubtotal = roundMoney(unitPrice * line.quantity)
      return { productId: line.productId, productName: product.name, quantity: line.quantity, saleUnit: line.saleUnit, stockQuantity, unitPrice, unitCost, lineSubtotal }
    })
    const subtotal = roundMoney(rawLines.reduce((sum, line) => sum + line.lineSubtotal, 0))
    if (input.data.discountAmount > subtotal) { await client.query('ROLLBACK'); return response.status(400).json({ error: 'Discount cannot exceed the sale subtotal' }) }
    const discountAmount = roundMoney(input.data.discountAmount)
    const totalAmount = roundMoney(subtotal - discountAmount)
    const amountPaid = roundMoney(input.data.amountPaid ?? totalAmount)
    if (amountPaid < totalAmount) { await client.query('ROLLBACK'); return response.status(400).json({ error: 'Amount paid cannot be less than the total amount due' }) }
    let allocatedDiscount = 0
    const lines = rawLines.map((line, index) => {
      const lineDiscount = index === rawLines.length - 1
        ? roundMoney(discountAmount - allocatedDiscount)
        : subtotal === 0 ? 0 : roundMoney(discountAmount * line.lineSubtotal / subtotal)
      allocatedDiscount = roundMoney(allocatedDiscount + lineDiscount)
      const lineTotal = roundMoney(line.lineSubtotal - lineDiscount)
      const lineProfit = roundMoney(lineTotal - line.unitCost * line.quantity)
      return { ...line, lineDiscount, lineTotal, lineProfit }
    })
    const totalProfit = roundMoney(lines.reduce((sum, line) => sum + line.lineProfit, 0))
    const changeDue = roundMoney(amountPaid - totalAmount)
    const created = await client.query('INSERT INTO sales (user_id, payment_method, subtotal, discount_amount, total_amount, amount_paid, change_due, total_profit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at', [seller.id, input.data.paymentMethod, subtotal, discountAmount, totalAmount, amountPaid, changeDue, totalProfit])
    const saleId = Number(created.rows[0].id)
    const receiptNumber = `FS-${new Date(created.rows[0].created_at).toISOString().slice(0, 10).replaceAll('-', '')}-${String(saleId).padStart(6, '0')}`
    await client.query('UPDATE sales SET receipt_number = $1 WHERE id = $2', [receiptNumber, saleId])
    for (const line of lines) {
      await client.query('INSERT INTO sale_items (sale_id, product_id, product_name, quantity, sale_unit, stock_quantity, unit_selling_price, unit_cost_price, line_subtotal, line_discount, line_total, line_profit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [saleId, line.productId, line.productName, line.quantity, line.saleUnit, line.stockQuantity, line.unitPrice, line.unitCost, line.lineSubtotal, line.lineDiscount, line.lineTotal, line.lineProfit])
      await client.query('UPDATE products SET current_stock = current_stock - $1, updated_at = NOW() WHERE id = $2', [line.stockQuantity, line.productId])
      await client.query('INSERT INTO stock_movements (product_id, user_id, movement_type, quantity, sale_id, note) VALUES ($1, $2, \'sale\', $3, $4, $5)', [line.productId, seller.id, -line.stockQuantity, saleId, `Sale ${receiptNumber}: ${line.quantity} ${line.saleUnit}`])
    }
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'sale.completed\', \'sale\', $4, $5, $6)', [seller.id, seller.name, seller.role, saleId, `${seller.name} recorded Sale ${receiptNumber} for ${subtotal}`, { receiptNumber, paymentMethod: input.data.paymentMethod, subtotal, totalProfit, items: lines }])
    await client.query('COMMIT')
    response.status(201).json({ sale: { id: saleId, receiptNumber, paymentMethod: input.data.paymentMethod, subtotal, discountAmount, totalAmount, amountPaid, changeDue, totalProfit, status: 'completed', createdAt: created.rows[0].created_at, items: lines } })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.get('/api/sales', requireAuth, asyncRoute(async (request, response) => {
  const user = signedIn(request)
  const userClause = user.role === 'admin' ? '' : 'AND s.user_id = $1'
  const values = user.role === 'admin' ? [] : [user.id]
  const sales = await pool.query(`SELECT s.id, s.receipt_number AS "receiptNumber", s.user_id AS "userId", u.name AS "attendantName", s.payment_method AS "paymentMethod", s.subtotal, s.discount_amount AS "discountAmount", s.total_amount AS "totalAmount", s.amount_paid AS "amountPaid", s.change_due AS "changeDue", s.total_profit AS "totalProfit", s.status, s.reversal_reason AS "reversalReason", s.created_at AS "createdAt", COALESCE(json_agg(json_build_object('productId', i.product_id, 'productName', i.product_name, 'quantity', i.quantity, 'saleUnit', i.sale_unit, 'stockQuantity', i.stock_quantity, 'unitPrice', i.unit_selling_price, 'unitCost', i.unit_cost_price, 'lineSubtotal', i.line_subtotal, 'lineDiscount', i.line_discount, 'lineTotal', i.line_total, 'lineProfit', i.line_profit)) FILTER (WHERE i.id IS NOT NULL), '[]') AS items FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN sale_items i ON i.sale_id = s.id WHERE TRUE ${userClause} GROUP BY s.id, u.name ORDER BY s.created_at DESC LIMIT 200`, values)
  response.json({ sales: sales.rows.map((sale) => ({ ...sale, subtotal: Number(sale.subtotal), discountAmount: Number(sale.discountAmount), totalAmount: Number(sale.totalAmount), amountPaid: Number(sale.amountPaid), changeDue: Number(sale.changeDue), totalProfit: Number(sale.totalProfit), items: sale.items.map((item: Record<string, unknown>) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, ['quantity', 'stockQuantity', 'unitPrice', 'unitCost', 'lineSubtotal', 'lineDiscount', 'lineTotal', 'lineProfit'].includes(key) ? Number(value) : value]))) })) })
}))

app.get('/api/receipts', requireAuth, asyncRoute(async (request, response) => {
  const user = signedIn(request)
  const search = typeof request.query.q === 'string' ? request.query.q.trim() : ''
  const from = typeof request.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(request.query.from) ? request.query.from : null
  const to = typeof request.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(request.query.to) ? request.query.to : null
  if (request.query.from && !from || request.query.to && !to) return response.status(400).json({ error: 'Dates must use YYYY-MM-DD format' })
  if (from && to && from > to) return response.status(400).json({ error: 'Start date must not be after end date' })
  const userClause = user.role === 'admin' ? '' : 'AND s.user_id = $4'
  const result = await pool.query(`SELECT s.id, s.receipt_number AS "receiptNumber", s.payment_method AS "paymentMethod", s.subtotal, s.discount_amount AS "discountAmount", s.total_amount AS "totalAmount", s.amount_paid AS "amountPaid", s.change_due AS "changeDue", s.status, s.user_id AS "userId", u.name AS "attendantName", s.created_at AS "createdAt" FROM sales s JOIN users u ON u.id = s.user_id WHERE ($1::text = '' OR s.receipt_number ILIKE '%' || $1 || '%') AND ($2::date IS NULL OR (s.created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date >= $2) AND ($3::date IS NULL OR (s.created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date < $3 + 1) ${userClause} ORDER BY s.created_at DESC LIMIT 200`, user.role === 'admin' ? [search, from, to] : [search, from, to, user.id])
  response.json({ receipts: result.rows.map((row) => ({ ...row, subtotal: Number(row.subtotal), discountAmount: Number(row.discountAmount), totalAmount: Number(row.totalAmount), amountPaid: Number(row.amountPaid), changeDue: Number(row.changeDue) })) })
}))

app.get('/api/receipts/:id', requireAuth, asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  const user = signedIn(request)
  if (!Number.isInteger(id) || id < 1) return response.status(400).json({ error: 'Invalid receipt id' })
  const scope = user.role === 'admin' ? '' : 'AND s.user_id = $2'
  const values = user.role === 'admin' ? [id] : [id, user.id]
  const result = await pool.query(`SELECT s.id, s.receipt_number AS "receiptNumber", s.subtotal, s.discount_amount AS "discountAmount", s.total_amount AS "totalAmount", s.amount_paid AS "amountPaid", s.change_due AS "changeDue", s.total_profit AS "totalProfit", s.payment_method AS "paymentMethod", s.status, s.reversal_reason AS "reversalReason", s.created_at AS "createdAt", u.name AS "attendantName", b.business_name AS "businessName", b.business_address AS "businessAddress", b.business_phone AS "businessPhone", b.business_email AS "businessEmail", b.logo_url AS "logoUrl", b.receipt_footer AS "receiptFooter", b.receipt_qr_enabled AS "receiptQrEnabled", b.currency_code AS "currencyCode", b.time_zone AS "timeZone", COALESCE(json_agg(json_build_object('productId', i.product_id, 'productName', i.product_name, 'quantity', i.quantity, 'saleUnit', i.sale_unit, 'stockQuantity', i.stock_quantity, 'unitPrice', i.unit_selling_price, 'lineSubtotal', i.line_subtotal, 'lineDiscount', i.line_discount, 'lineTotal', i.line_total)) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items FROM sales s JOIN users u ON u.id = s.user_id CROSS JOIN business_profile b LEFT JOIN sale_items i ON i.sale_id = s.id WHERE s.id = $1 ${scope} GROUP BY s.id, u.name, b.id`, values)
  if (!result.rowCount) return response.status(404).json({ error: 'Receipt not found' })
  response.json({ receipt: { ...result.rows[0], subtotal: Number(result.rows[0].subtotal), discountAmount: Number(result.rows[0].discountAmount), totalAmount: Number(result.rows[0].totalAmount), amountPaid: Number(result.rows[0].amountPaid), changeDue: Number(result.rows[0].changeDue), items: result.rows[0].items.map((item: Record<string, unknown>) => ({ ...item, quantity: Number(item.quantity), stockQuantity: Number(item.stockQuantity), unitPrice: Number(item.unitPrice), lineSubtotal: Number(item.lineSubtotal), lineDiscount: Number(item.lineDiscount), lineTotal: Number(item.lineTotal) })) } })
}))

app.get('/api/sales/:id/receipt', requireAuth, asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  const user = signedIn(request)
  if (!Number.isInteger(id) || id < 1) return response.status(400).json({ error: 'Invalid sale id' })
  const scope = user.role === 'admin' ? '' : 'AND s.user_id = $2'
  const values = user.role === 'admin' ? [id] : [id, user.id]
  const result = await pool.query(`SELECT s.id, s.receipt_number AS "receiptNumber", s.payment_method AS "paymentMethod", s.subtotal, s.status, s.created_at AS "createdAt", u.name AS "attendantName", COALESCE(json_agg(json_build_object('productName', i.product_name, 'quantity', i.quantity, 'saleUnit', i.sale_unit, 'unitPrice', i.unit_selling_price, 'lineTotal', i.line_total)) FILTER (WHERE i.id IS NOT NULL), '[]') AS items FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN sale_items i ON i.sale_id = s.id WHERE s.id = $1 ${scope} GROUP BY s.id, u.name`, values)
  if (!result.rowCount) return response.status(404).json({ error: 'Sale not found' })
  response.json({ receipt: result.rows[0] })
}))

app.post('/api/sales/:id/reverse', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  const input = validated(reversalSchema, request.body)
  if (!Number.isInteger(id) || id < 1 || 'error' in input) return response.status(400).json({ error: 'A valid sale id and reversal reason are required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const sale = await client.query('SELECT id, status, receipt_number FROM sales WHERE id = $1 FOR UPDATE', [id])
    if (!sale.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Sale not found' }) }
    if (sale.rows[0].status !== 'completed') { await client.query('ROLLBACK'); return response.status(409).json({ error: 'Sale has already been reversed' }) }
    const items = await client.query('SELECT product_id, product_name, quantity, sale_unit, stock_quantity FROM sale_items WHERE sale_id = $1 ORDER BY product_id FOR UPDATE', [id])
    for (const item of items.rows) {
      await client.query('UPDATE products SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2', [item.stock_quantity, item.product_id])
      await client.query('INSERT INTO stock_movements (product_id, user_id, movement_type, quantity, sale_id, note) VALUES ($1, $2, \'sale_reversal\', $3, $4, $5)', [item.product_id, signedIn(request).id, item.stock_quantity, id, `Reversal of ${sale.rows[0].receipt_number}: ${item.quantity} ${item.sale_unit}`])
    }
    await client.query('UPDATE sales SET status = \'reversed\', reversed_by = $1, reversed_at = NOW(), reversal_reason = $2 WHERE id = $3', [signedIn(request).id, input.data.reason, id])
    const actor = signedIn(request)
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, before_data, after_data, reason) VALUES ($1, $2, $3, \'sale.reversed\', \'sale\', $4, $5, $6, $7, $8)', [actor.id, actor.name, actor.role, id, `${actor.name} reversed Sale ${sale.rows[0].receipt_number}`, sale.rows[0], { status: 'reversed' }, input.data.reason])
    await client.query('COMMIT')
    response.json({ message: 'Sale reversed and stock restored', saleId: id })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.get('/api/stock/adjustment-requests', requireAuth, asyncRoute(async (request, response) => {
  const user = signedIn(request)
  const scope = user.role === 'admin' ? '' : 'AND r.requested_by = $1'
  const values = user.role === 'admin' ? [] : [user.id]
  const result = await pool.query(`SELECT r.id, r.product_id AS "productId", p.name AS "productName", p.unit, r.quantity, r.reason, r.status, r.requested_by AS "requestedById", u.name AS "requestedBy", r.created_at AS "createdAt", r.review_note AS "reviewNote" FROM stock_adjustment_requests r JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.requested_by WHERE r.status = 'pending' ${scope} ORDER BY r.created_at`, values)
  response.json({ requests: result.rows })
}))

app.patch('/api/stock/adjustment-requests/:id', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const id = Number(request.params.id)
  const input = validated(adjustmentReviewSchema, request.body)
  if (!Number.isInteger(id) || id < 1 || 'error' in input) return response.status(400).json({ error: 'A valid adjustment decision is required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const found = await client.query('SELECT id, product_id, quantity, reason, status FROM stock_adjustment_requests WHERE id = $1 FOR UPDATE', [id])
    if (!found.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Adjustment request not found' }) }
    const adjustment = found.rows[0]
    if (adjustment.status !== 'pending') { await client.query('ROLLBACK'); return response.status(409).json({ error: 'Adjustment request has already been reviewed' }) }
    if (input.data.decision === 'approved') {
      const product = await client.query('SELECT current_stock FROM products WHERE id = $1 AND active = TRUE FOR UPDATE', [adjustment.product_id])
      if (!product.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Active product not found' }) }
      if (Number(product.rows[0].current_stock) + Number(adjustment.quantity) < 0) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'Approval would reduce stock below zero' }) }
      await client.query('UPDATE products SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2', [adjustment.quantity, adjustment.product_id])
      await client.query('INSERT INTO stock_movements (product_id, user_id, movement_type, quantity, note) VALUES ($1, $2, \'adjustment\', $3, $4)', [adjustment.product_id, signedIn(request).id, adjustment.quantity, `Approved request #${id}: ${adjustment.reason}`])
    }
    await client.query('UPDATE stock_adjustment_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3 WHERE id = $4', [input.data.decision, signedIn(request).id, input.data.reviewNote ?? null, id])
    const actor = signedIn(request)
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, before_data, after_data, reason) VALUES ($1, $2, $3, $4, \'stock_adjustment_request\', $5, $6, $7, $8, $9)', [actor.id, actor.name, actor.role, `stock_adjustment.${input.data.decision}`, id, `${actor.name} ${input.data.decision} stock adjustment request #${id}`, adjustment, { status: input.data.decision, reviewNote: input.data.reviewNote ?? null }, input.data.reviewNote ?? adjustment.reason])
    await client.query('COMMIT')
    response.json({ requestId: id, status: input.data.decision })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.post('/api/income', requireAuth, asyncRoute(async (request, response) => {
  const input = validated(incomeSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ensureBusinessDayOpen(client, signedIn(request).id))) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'This business day is already closed' }) }
    const actor = signedIn(request)
    const entry = await client.query('INSERT INTO income_entries (user_id, category, description, amount, payment_method) VALUES ($1, $2, $3, $4, $5) RETURNING id, category, description, amount, payment_method AS "paymentMethod", created_at AS "createdAt"', [actor.id, input.data.category, input.data.description, input.data.amount, input.data.paymentMethod])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'finance.income_recorded\', \'income\', $4, $5, $6)', [actor.id, actor.name, actor.role, entry.rows[0].id, `${actor.name} recorded ${input.data.category} income ${input.data.amount}`, entry.rows[0]])
    await client.query('COMMIT')
    response.status(201).json({ entry: entry.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.post('/api/expenses', requireAuth, asyncRoute(async (request, response) => {
  const input = validated(expenseSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ensureBusinessDayOpen(client, signedIn(request).id))) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'This business day is already closed' }) }
    const actor = signedIn(request)
    const entry = await client.query('INSERT INTO expenses (user_id, category, description, amount, payment_method) VALUES ($1, $2, $3, $4, $5) RETURNING id, category, description, amount, payment_method AS "paymentMethod", created_at AS "createdAt"', [actor.id, input.data.category, input.data.description, input.data.amount, input.data.paymentMethod])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'finance.expense_recorded\', \'expense\', $4, $5, $6)', [actor.id, actor.name, actor.role, entry.rows[0].id, `${actor.name} recorded ${input.data.category} expense ${input.data.amount}`, entry.rows[0]])
    await client.query('COMMIT')
    response.status(201).json({ entry: entry.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.get('/api/finance/daily', requireAuth, asyncRoute(async (request, response) => {
  const user = signedIn(request)
  const targetUser = user.role === 'admin' && request.query.userId ? Number(request.query.userId) : user.id
  if (!Number.isInteger(targetUser) || targetUser < 1) return response.status(400).json({ error: 'Invalid user id' })
  const [totals, date, closure] = await Promise.all([
    dailyTotals(pool, targetUser),
    pool.query('SELECT (NOW() AT TIME ZONE time_zone)::date AS "businessDate" FROM business_profile WHERE id = 1'),
    pool.query('SELECT id, business_date AS "businessDate", actual_cash AS "actualCash", expected_cash AS "expectedCash", difference, closed_at AS "closedAt" FROM cash_closures WHERE user_id = $1 AND business_date = (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date', [targetUser]),
  ])
  response.json({ userId: targetUser, businessDate: date.rows[0].businessDate, ...totals, expected_cash: roundMoney(totals.cash_sales + totals.cash_income - totals.cash_expenses), closure: closure.rows[0] ?? null })
}))

app.post('/api/finance/close', requireAuth, asyncRoute(async (request, response) => {
  const input = validated(cashCloseSchema, request.body)
  if ('error' in input) return response.status(400).json({ error: input.error })
  const user = signedIn(request)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await ensureBusinessDayOpen(client, user.id))) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'This business day is already closed' }) }
    const totals = await dailyTotals(client, user.id)
    const businessDate = await currentBusinessDate(client)
    const expectedCash = roundMoney(totals.cash_sales + totals.cash_income - totals.cash_expenses)
    const difference = roundMoney(input.data.actualCash - expectedCash)
    const closure = await client.query(`INSERT INTO cash_closures (user_id, business_date, total_sales, cash_sales, momo_sales, other_sales, other_income, cash_income, expenses, cash_expenses, expected_cash, actual_cash, difference)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, business_date AS "businessDate", total_sales AS "totalSales", cash_sales AS "cashSales", momo_sales AS "momoSales", other_sales AS "otherSales", other_income AS "otherIncome", cash_income AS "cashIncome", expenses, cash_expenses AS "cashExpenses", expected_cash AS "expectedCash", actual_cash AS "actualCash", difference, closed_at AS "closedAt"`, [user.id, businessDate, totals.total_sales, totals.cash_sales, totals.momo_sales, totals.other_sales, totals.other_income, totals.cash_income, totals.expenses, totals.cash_expenses, expectedCash, input.data.actualCash, difference])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'cash_day.closed\', \'cash_closure\', $4, $5, $6)', [user.id, user.name, user.role, closure.rows[0].id, `${user.name} closed daily tally with actual cash ${input.data.actualCash}; difference ${difference}`, closure.rows[0]])
    await client.query('COMMIT')
    response.status(201).json({ closure: closure.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.post('/api/finance/reopen', requireAuth, asyncRoute(async (request, response) => {
  const user = signedIn(request)
  const targetUserId = user.role === 'admin' && request.body && typeof request.body === 'object' && 'userId' in request.body
    ? Number((request.body as { userId?: unknown }).userId)
    : user.id
  if (!Number.isInteger(targetUserId) || targetUserId < 1) return response.status(400).json({ error: 'A valid user id is required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const businessDate = await currentBusinessDate(client)
    const existing = await client.query('SELECT id FROM cash_closures WHERE user_id = $1 AND business_date = $2 FOR UPDATE', [targetUserId, businessDate])
    if (!existing.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'No closed day found to reopen' }) }
    await client.query('DELETE FROM cash_closures WHERE user_id = $1 AND business_date = $2', [targetUserId, businessDate])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, after_data) VALUES ($1, $2, $3, \'cash_day.reopened\', \'cash_closure\', $4, $5, $6)', [user.id, user.name, user.role, existing.rows[0].id, `${user.name} reopened the cash day for user #${targetUserId} on ${businessDate}`, { userId: targetUserId, businessDate }])
    await client.query('COMMIT')
    response.json({ reopened: true, userId: targetUserId, businessDate })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.get('/api/finance/closures', requireAuth, allowRoles('admin'), asyncRoute(async (_request, response) => {
  const result = await pool.query('SELECT c.id, c.user_id AS "userId", u.name AS "attendantName", c.business_date AS "businessDate", c.total_sales AS "totalSales", c.cash_sales AS "cashSales", c.momo_sales AS "momoSales", c.other_sales AS "otherSales", c.expenses, c.expected_cash AS "expectedCash", c.actual_cash AS "actualCash", c.difference, c.closed_at AS "closedAt" FROM cash_closures c JOIN users u ON u.id = c.user_id ORDER BY c.business_date DESC, c.closed_at DESC LIMIT 100')
  response.json({ closures: result.rows })
}))

app.get('/api/audit', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const limit = Math.min(Math.max(Number(request.query.limit || 100), 1), 500)
  const action = typeof request.query.action === 'string' ? request.query.action : null
  const entityType = typeof request.query.entityType === 'string' ? request.query.entityType : null
  const result = await pool.query('SELECT id, actor_user_id AS "actorUserId", actor_name_snapshot AS "actorName", actor_role_snapshot AS "actorRole", action, entity_type AS "entityType", entity_id AS "entityId", summary, before_data AS "before", after_data AS "after", reason, occurred_at AS "occurredAt" FROM audit_events WHERE ($1::text IS NULL OR action = $1) AND ($2::text IS NULL OR entity_type = $2) ORDER BY occurred_at DESC LIMIT $3', [action, entityType, limit])
  response.json({ events: result.rows })
}))

app.get('/api/finance/transactions', requireAuth, asyncRoute(async (request, response) => {
  const user = signedIn(request)
  const values = user.role === 'admin' ? [] : [user.id]
  const [sales, income, expenses] = await Promise.all([
    pool.query(`SELECT s.id, 'sale' AS type, s.receipt_number AS reference, s.subtotal AS amount, s.payment_method AS "paymentMethod", s.status, s.user_id AS "userId", u.name AS "attendantName", s.created_at AS "createdAt" FROM sales s JOIN users u ON u.id = s.user_id WHERE TRUE ${user.role === 'admin' ? '' : 'AND s.user_id = $1'} ORDER BY s.created_at DESC LIMIT 200`, values),
    pool.query(`SELECT e.id, 'income' AS type, e.category, e.description, e.amount, e.payment_method AS "paymentMethod", e.user_id AS "userId", u.name AS "attendantName", e.created_at AS "createdAt", e.voided_at IS NOT NULL AS voided FROM income_entries e JOIN users u ON u.id = e.user_id WHERE TRUE ${user.role === 'admin' ? '' : 'AND e.user_id = $1'} ORDER BY e.created_at DESC LIMIT 200`, values),
    pool.query(`SELECT e.id, 'expense' AS type, e.category, e.description, e.amount, e.payment_method AS "paymentMethod", e.user_id AS "userId", u.name AS "attendantName", e.created_at AS "createdAt", e.voided_at IS NOT NULL AS voided FROM expenses e JOIN users u ON u.id = e.user_id WHERE TRUE ${user.role === 'admin' ? '' : 'AND e.user_id = $1'} ORDER BY e.created_at DESC LIMIT 200`, values),
  ])
  response.json({ transactions: [...sales.rows, ...income.rows, ...expenses.rows].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()).slice(0, 300) })
}))

app.patch('/api/finance/:type/:id', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const type = request.params.type
  const table = type === 'income' ? 'income_entries' : type === 'expense' ? 'expenses' : null
  const id = Number(request.params.id)
  const input = validated(financeEntrySchema.extend({ reason: z.string().trim().min(3).max(500) }), request.body)
  if (!table || !Number.isInteger(id) || id < 1 || 'error' in input) return response.status(400).json({ error: 'Valid transaction correction details are required' })
  const allowedCategories = type === 'income' ? ['delivery_charge', 'miscellaneous', 'other'] : ['electricity', 'water', 'transport', 'fuel', 'repairs', 'maintenance', 'salaries', 'rent', 'packaging', 'other']
  if (!allowedCategories.includes(input.data.category)) return response.status(400).json({ error: 'Category does not match transaction type' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const before = await client.query(`SELECT id, category, description, amount, payment_method AS "paymentMethod", user_id AS "userId", voided_at FROM ${table} WHERE id = $1 FOR UPDATE`, [id])
    if (!before.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Transaction not found' }) }
    if (before.rows[0].voided_at) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'Voided transactions cannot be corrected' }) }
    const updated = await client.query(`UPDATE ${table} SET category = $1, description = $2, amount = $3, payment_method = $4 WHERE id = $5 RETURNING id, category, description, amount, payment_method AS "paymentMethod", user_id AS "userId"`, [input.data.category, input.data.description, input.data.amount, input.data.paymentMethod, id])
    const actor = signedIn(request)
    await client.query('INSERT INTO transaction_audit (user_id, record_type, record_id, action, before_data, after_data, reason) VALUES ($1, $2, $3, \'corrected\', $4, $5, $6)', [actor.id, type, id, before.rows[0], updated.rows[0], input.data.reason])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, before_data, after_data, reason) VALUES ($1, $2, $3, \'finance.transaction_corrected\', $4, $5, $6, $7, $8, $9)', [actor.id, actor.name, actor.role, type, id, `${actor.name} corrected ${type} #${id}`, before.rows[0], updated.rows[0], input.data.reason])
    await client.query('COMMIT')
    response.json({ transaction: updated.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.post('/api/finance/:type/:id/void', requireAuth, allowRoles('admin'), asyncRoute(async (request, response) => {
  const type = request.params.type
  const table = type === 'income' ? 'income_entries' : type === 'expense' ? 'expenses' : null
  const id = Number(request.params.id)
  const input = validated(z.object({ reason: z.string().trim().min(3).max(500) }), request.body)
  if (!table || !Number.isInteger(id) || id < 1 || 'error' in input) return response.status(400).json({ error: 'Valid transaction and reason are required' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const before = await client.query(`SELECT id, category, description, amount, payment_method AS "paymentMethod", user_id AS "userId", voided_at FROM ${table} WHERE id = $1 FOR UPDATE`, [id])
    if (!before.rowCount) { await client.query('ROLLBACK'); return response.status(404).json({ error: 'Transaction not found' }) }
    if (before.rows[0].voided_at) { await client.query('ROLLBACK'); return response.status(409).json({ error: 'Transaction has already been voided' }) }
    const updated = await client.query(`UPDATE ${table} SET voided_at = NOW(), voided_by = $1 WHERE id = $2 RETURNING id, category, description, amount, payment_method AS "paymentMethod", user_id AS "userId", voided_at AS "voidedAt"`, [signedIn(request).id, id])
    const actor = signedIn(request)
    await client.query('INSERT INTO transaction_audit (user_id, record_type, record_id, action, before_data, after_data, reason) VALUES ($1, $2, $3, \'voided\', $4, $5, $6)', [actor.id, type, id, before.rows[0], updated.rows[0], input.data.reason])
    await client.query('INSERT INTO audit_events (actor_user_id, actor_name_snapshot, actor_role_snapshot, action, entity_type, entity_id, summary, before_data, after_data, reason) VALUES ($1, $2, $3, \'finance.transaction_voided\', $4, $5, $6, $7, $8, $9)', [actor.id, actor.name, actor.role, type, id, `${actor.name} voided ${type} #${id}`, before.rows[0], updated.rows[0], input.data.reason])
    await client.query('COMMIT')
    response.json({ transaction: updated.rows[0] })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}))

app.get('/api/dashboard', requireAuth, asyncRoute(async (request, response) => {
  const user = signedIn(request)
  const [counts, low, purchases] = await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER (WHERE active) AS total_products, COALESCE(SUM(current_stock) FILTER (WHERE active), 0) AS current_stock FROM products`),
    pool.query('SELECT COUNT(*) AS count FROM products WHERE active = TRUE AND current_stock <= minimum_stock'),
    pool.query("SELECT COALESCE(SUM(quantity * COALESCE(unit_cost, 0)), 0) AS total FROM stock_movements WHERE movement_type = 'received' AND (created_at AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date = (NOW() AT TIME ZONE (SELECT time_zone FROM business_profile WHERE id = 1))::date")
  ])
  const totals = await dailyTotals(pool, user.role === 'admin' ? null : user.id)
  const expectedCash = roundMoney(totals.cash_sales + totals.cash_income - totals.cash_expenses)
  response.json({ totalProducts: Number(counts.rows[0].total_products), currentStock: Number(counts.rows[0].current_stock), lowStockCount: Number(low.rows[0].count), todayPurchases: Number(purchases.rows[0].total), todaySales: totals.total_sales, todayExpenses: totals.expenses, currentProfit: roundMoney(totals.sales_profit + totals.other_income - totals.expenses), ...totals, expectedCash })
}))

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distPath))
  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(path.join(distPath, 'index.html'))
  })
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  response.status(500).json({ error: 'Internal server error' })
})

app.listen(port, () => console.info(`Gosh Cold Store API listening on http://localhost:${port}`))
