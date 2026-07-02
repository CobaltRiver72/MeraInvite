# 05 · CI/CD, Environments, Staging & Rollbacks

> Goal: a strong release foundation — main = production, every branch gets its own URL, automated checks before merge, one-click rollback.

## Branch & environment model
| Branch | Environment | URL | Keys |
|---|---|---|---|
| `main` | **Production** | merainvite.com | **live** Stripe/Razorpay, prod Supabase |
| `dev` | **Staging** (long-lived) | dev branch preview URL | **test** keys, staging/preview Supabase |
| feature branches | **Preview** (per branch/PR) | auto Vercel preview URL | test keys |

- **Vercel auto-creates a Preview Deployment with a unique URL for every branch/PR** — that's our per-branch staging out of the box. `dev` is the stable staging target for review.
- **Production env vars** (live keys) are scoped to Production only in Vercel; Preview/Dev use **test keys**, so a leaked preview can never move real money.

## Database across environments
- **Supabase preview branches** (or a dedicated staging project) so migrations are tested against a real DB before prod. New migration files trigger a migration on the preview instance.
- **Never** point a preview deploy at the production database.
- Migrations apply to prod only via CI on merge to `main` (`supabase db push`).

## CI checks (must pass before merge)
Run on every PR (GitHub Actions or Vercel checks):
- [ ] `tsc --noEmit` (type check) and `eslint` (lint).
- [ ] Unit tests (business logic: pricing, entitlement, idempotency helpers).
- [ ] **gitleaks** secret scan.
- [ ] `npm audit` / Dependabot for vulnerable deps.
- [ ] Build succeeds; Preview deploy goes green.
- [ ] (optional) Playwright smoke test against the preview URL (load catalog, open editor, run a Stripe **test** checkout).

## Review & deploy flow
1. Branch from `dev` → open PR → Vercel builds a **preview URL** → CI checks run.
2. **Review the diff**; test on the preview URL; verify migrations on the preview DB.
3. Merge to `dev` (staging) → final QA on the staging URL.
4. Merge `dev` → `main` → **production deploy**; migrations pushed.

## Deploy checklist (per release)
- [ ] CI green (types, lint, tests, gitleaks, audit).
- [ ] Migrations tested on preview DB; reversible/forward-only confirmed.
- [ ] Env vars present in the target environment (no missing secret — `env.ts` will refuse to boot otherwise).
- [ ] Webhooks point at the right environment (test vs live endpoints).
- [ ] Smoke test the critical path on staging: catalog → editor → **test** purchase → render → download → email.
- [ ] Core Web Vitals not regressed.

## Rollbacks (one-click)
- **Vercel: Instant Rollback** — promote any previous deployment back to production from the dashboard in seconds (the old build is still hosted). This is the primary rollback.
- **Code:** `git revert` the bad commit → redeploy (keeps history clean).
- **Database:** migrations are the risky part — a code rollback does **not** undo a schema change. So: keep migrations **additive/backward-compatible** when possible (add columns, don't drop in the same release as code that needs them); for destructive changes, take a backup first and have a down-migration ready; worst case use **PITR** to restore.
- Document a **rollback runbook**: "prod is broken → Vercel Instant Rollback to last-good → if DB involved, assess migration → restore via PITR if needed."

## Version control hygiene
- Conventional, meaningful commit messages; PRs small and focused.
- Tag production releases (`v0.1.0`) so a rollback target is obvious.
- Protect `main`: require PR + passing checks + review before merge.

## Checklist
- [ ] `main`=prod, `dev`=staging, per-branch preview URLs.
- [ ] Live keys only in Production env; test keys in Preview/Dev.
- [ ] Supabase preview/staging DB; migrations never tested on prod.
- [ ] CI: types, lint, tests, gitleaks, audit, build — required to merge.
- [ ] Branch protection on `main`.
- [ ] Deploy checklist + rollback runbook written; PITR enabled.
- [ ] Vercel Instant Rollback verified once (practice it before you need it).
