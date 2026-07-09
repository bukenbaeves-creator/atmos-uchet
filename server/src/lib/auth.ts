import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export interface TokenPayload {
  id: number;
  login: string;
  role: 'admin' | 'operator' | 'nurse';
  fio: string;
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export const signToken = (payload: TokenPayload) =>
  jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtTtl });

export const verifyToken = (token: string): TokenPayload =>
  jwt.verify(token, config.jwtSecret) as TokenPayload;

export const COOKIE_NAME = 'atmos_token';
