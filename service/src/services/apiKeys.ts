import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of randomness. The prefix only helps humans and secret scanners recognise it. */
export const generateApiKey = () => 'mk_' + randomBytes(32).toString('base64url');

/**
 * Only this hash is stored. A fast hash is correct here (unlike passwords): the key is high-entropy
 * random, so it cannot be brute-forced, and we need an indexed O(1) lookup on every request.
 */
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');
