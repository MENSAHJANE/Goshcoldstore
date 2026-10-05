import 'dotenv/config'
import { Pool } from 'pg'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
})

export type UserRole = 'admin' | 'attendant'
export type AuthenticatedRequest = import('express').Request & {
  user: { id: number; role: UserRole; name: string; email: string }
}