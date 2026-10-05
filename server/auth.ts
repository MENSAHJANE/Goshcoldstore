import 'dotenv/config'
import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { pool, type AuthenticatedRequest, type UserRole } from './db.js'

const secret = process.env.JWT_SECRET ?? ''
if (!secret || secret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters')
}

export function createToken(user: { id: number; role: UserRole; name: string; email: string }) {
  return jwt.sign(user, secret, { expiresIn: '8h', issuer: 'essumans-cold-store-api' })
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return response.status(401).json({ error: 'Authentication required' })
  let decoded: jwt.JwtPayload
  try {
    const verified = jwt.verify(token, secret, { issuer: 'essumans-cold-store-api' })
    if (typeof verified === 'string' || typeof verified.id !== 'number') throw new Error('Invalid token')
    decoded = verified
  } catch {
    return response.status(401).json({ error: 'Invalid or expired token' })
  }
  try {
    const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1 AND active = TRUE', [decoded.id])
    const user = result.rows[0]
    if (!user) return response.status(401).json({ error: 'Account is no longer active' })
    ;(request as AuthenticatedRequest).user = { id: Number(user.id), role: user.role as UserRole, name: user.name, email: user.email }
    return next()
  } catch (error) {
    return next(error)
  }
}

export function allowRoles(...roles: UserRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    const user = (request as AuthenticatedRequest).user
    if (!user || !roles.includes(user.role)) return response.status(403).json({ error: 'You do not have permission to perform this action' })
    return next()
  }
}