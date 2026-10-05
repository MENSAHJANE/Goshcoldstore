import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { pool } from './db.js'

async function initialize() {
  const schema = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')
  await pool.query(schema)

  const name = process.env.ADMIN_NAME
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD
  if (name && email && password) {
    if (password.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters')
    const passwordHash = await bcrypt.hash(password, 12)
    await pool.query(`INSERT INTO users (name, email, password_hash, role, active)
      VALUES ($1, $2, $3, 'admin', TRUE)
      ON CONFLICT (email) DO UPDATE
      SET name = EXCLUDED.name,
          password_hash = EXCLUDED.password_hash,
          role = 'admin',
          active = TRUE,
          updated_at = NOW()`, [name, email.toLowerCase(), passwordHash])
    console.info(`Admin account refreshed for ${email.toLowerCase()}`)
  } else {
    console.info('Schema is ready. Set ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD to create the initial admin.')
  }
}

initialize().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => pool.end())
