import { z } from 'zod';
import { canonicalizeArtifact } from './canonical.js';

export const DATASET_COMMIT = '4fb99b3749adf0d10b5977089ff4c73f4f522240' as const;
export const CANONICALIZATION_VERSION = 'node-stable-json-v1' as const;
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const UuidSchema = z.uuid().regex(/^[a-f0-9-]{36}$/);
export const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const RecordIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:@.-]{0,159}$/);
export const VersionSchema = z.int().min(1).max(2);
export const SafeCountSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PositiveCountSchema = SafeCountSchema.min(1);
export const TextSchema = z.string().min(1).max(16_384).refine(value => value.trim().length > 0)
  .refine(value => { try { canonicalizeArtifact(value); return true; } catch { return false; } });
export const CompanyIdSchema = z.string().regex(/^C\d{3}$/).refine(id => Number(id.slice(1)) > 0);
export const ResearcherIdSchema = z.string().regex(/^R\d{4}$/).refine(id => Number(id.slice(1)) > 0);
export const ChallengeIdSchema = z.string().regex(/^C\d{3}-CH[1-9]\d?$/);
export const AgentRoleSchema = z.enum(['proposer', 'counter-evidence', 'critic']);
export const TimestampSchema = z.iso.datetime({ precision: 3 });
export const JsonPointerSchema = z.string().max(2048).refine(pointer => {
  try { canonicalizeArtifact(pointer); } catch { return false; }
  if (pointer === '') return true;
  if (!pointer.startsWith('/')) return false;
  return pointer.slice(1).split('/').every(token => !/~(?:[^01]|$)/.test(token)
    && !/^-\d+$/.test(token) && !/^0\d+$/.test(token));
}, 'Expected a project JSON pointer without invalid escapes or array-like negative/leading-zero indices.');

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.unknown().superRefine((value, ctx) => {
  try { canonicalizeArtifact(value); } catch { ctx.addIssue({ code: 'custom', message: 'Expected strict finite JSON.' }); }
}).transform(value => value as JsonValue);

export function unique(values: readonly unknown[]): boolean { return new Set(values).size === values.length; }
export function sameCompany(companyId: string, challengeId: string): boolean {
  return challengeId.startsWith(`${companyId}-CH`);
}
