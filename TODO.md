# qbase — Master TODO

> Created 2026-04-25. Add/modify freely. Check off when done.

---

## 🧹 Remove Beta Whitelist Vestiges

The beta gate is already open (`isWhitelisted()` → `true`), but the entire whitelist infrastructure is still wired in. Some of it is dead code, some of it is actively misused as admin auth. Clean it all out properly.

### What's still standing

| Layer | File | Status |
|-------|------|--------|
| Service | `worker/services/BetaWhitelistService.ts` | **Mixed** — `isWhitelisted()` always true (dead), `isAdmin()` used by topics/admin routes (alive), CRUD still intact |
| DB | D1 `beta_whitelist` table (migration 0021) | Dead — no longer gating anything |
| Migration | `migrations/0021_create_beta_whitelist_table.sql` | Historical artifact |
| Worker route | `worker/routes/admin.ts` — `/api/beta/check` and `/api/admin/beta-whitelist/*` | Dead gating, stale CRUD |
| Worker route | `worker/routes/users.ts` — whitelist check in user creation | Dead (always passes) |
| Worker route | `worker/routes/topics.ts` — `BetaWhitelistService.isAdmin()` for backfill/metrics auth | **Alive** — needs new home |
| Client page | `src/pages/BetaWhitelistPage.tsx` + `.css` | Dead admin UI |
| Client component | `src/components/BetaAccessModal.tsx` + `.css` | Dead gate modal |
| Client context | `src/context/AuthContext.tsx` — BetaAccessModal state + import + render | Dead |
| Client router | `src/App.tsx` — `/admin/beta-whitelist` route | Dead |
| Worker entry | `worker/index.ts` — beta whitelist route handler | Dead |

### Plan

1. **Extract `isAdmin`** into a new `AdminService` (or inline) with `ADMIN_FIDS = [10215]` — this is a real auth concern, not a whitelist concern
2. **Update `topics.ts`** to use the new admin check
3. **Update `admin.ts`** to use the new admin check, strip whitelist CRUD routes
4. **Strip `users.ts`** — remove the dead whitelist check block
5. **Remove client files:** `BetaAccessModal.*`, `BetaWhitelistPage.*`
6. **Clean `AuthContext.tsx`** — remove BetaAccessModal import, state, and render
7. **Clean `App.tsx`** — remove lazy import and route
8. **Clean `worker/index.ts`** — remove beta whitelist route handler
9. **Delete `BetaWhitelistService.ts`**
10. **Create D1 migration** to DROP TABLE `beta_whitelist`
11. **Build + test** — confirm nothing breaks

---

## 📋 Other Items

_(add future items here)_
