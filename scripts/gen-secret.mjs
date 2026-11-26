// Prints a new random secret (256 bits, URL-safe). Usage: node scripts/gen-secret.mjs
import crypto from 'node:crypto';
console.log(crypto.randomBytes(32).toString('base64url'));
