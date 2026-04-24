# Database Migrations

This directory contains SQL migration files for the Qbase database schema.

## Migration Files

| File | Description | Date | Status |
|------|-------------|------|--------|
| `0001_create_queries_table.sql` | Initial queries table | 2025-11-30 | ✅ Applied |
| `0002_create_temporary_answers_table.sql` | Temporary answers for tourists | 2024-12-20 | ✅ Applied |
| `0003_add_query_type_field.sql` | Question taxonomy support (query_type + taxonomy) | 2025-12-27 | ✅ Applied |
| `0004_remove_query_type_field.sql` | Remove redundant query_type field | 2025-12-27 | 🆕 Ready |
| `0005_add_taxonomy_indexes.sql` | Indexes for taxonomy JSON field filtering | 2025-12-27 | 🆕 Ready |
| `0006_create_direct_queries_table.sql` | Direct queries table with payment escrow | 2025-12-27 | 🆕 Ready |
| `0007_create_direct_query_responses_table.sql` | Direct query responses (accept/decline/counter) | 2025-12-27 | 🆕 Ready |
| `0008_add_audience_fields_to_direct_queries.sql` | Add answer privacy/audience fields to direct queries | 2025-12-27 | 🆕 Ready |
| `0009_add_privacy_negotiation_to_responses.sql` | Add privacy negotiation fields to responses | 2025-12-27 | 🆕 Ready |
| `0010_create_farcaster_tables.sql` | Create Farcaster integration tables (casts, reactions, replies, sync log) | 2025-12-29 | 🆕 Ready |
| `0011_rename_users_to_alpha_users.sql` | Rename alpha_users to Users | 2025-12-29 | ✅ Applied |
| `0012_create_user_signers_table.sql` | User signers for authentication | 2025-12-29 | ✅ Applied |
| `0013_fix_user_signers_fk.sql` | Fix foreign key for user_signers | 2025-12-29 | ✅ Applied |
| `0014_create_answers_table.sql` | Public answers table for D1 storage | 2025-12-31 | 🆕 Ready |
| `0047_create_answer_snap.sql` | Snap poll silent votes + has_snap flag | 2026-04-24 | 🆕 Ready |

## Running Migrations

### Development
```bash
yarn migrate:dev
# or
wrangler d1 migrations apply dev-qbase --config wrangler.dev.jsonc
```

### Staging
```bash
yarn migrate:staging
# or
wrangler d1 migrations apply staging-qbase --config wrangler.staging.jsonc
```

### Production
```bash
yarn migrate:prod
# or
wrangler d1 migrations apply prod-qbase --config wrangler.jsonc
```

## Creating New Migrations

1. Create a new file with the next sequential number:
   ```bash
   touch migrations/0004_your_migration_name.sql
   ```

2. Add migration header:
   ```sql
   -- Migration number: 0004 	 YYYY-MM-DDTHH:MM:SS.000Z
   -- Purpose: Brief description
   -- Related: docs/relevant-doc.md
   ```

3. Write your migration SQL:
   ```sql
   ALTER TABLE table_name ADD COLUMN new_column TEXT;
   CREATE INDEX IF NOT EXISTS idx_name ON table_name(column);
   ```

4. Add rollback instructions in comments:
   ```sql
   -- Rollback (if needed):
   -- DROP INDEX IF EXISTS idx_name;
   -- ALTER TABLE table_name DROP COLUMN new_column;
   ```

5. Test locally:
   ```bash
   wrangler d1 migrations apply dev-qbase --local --config wrangler.dev.jsonc
   ```

## Migration Best Practices

### DO ✅
- Always create backups before applying migrations (CI/CD does this automatically)
- Test migrations in dev first, then staging, then production
- Use `IF NOT EXISTS` for CREATE statements
- Use `IF EXISTS` for DROP statements
- Set default values for new columns
- Create indexes for frequently filtered/joined columns
- Document the purpose and related features
- Include rollback instructions in comments
- Test rollback procedures in dev

### DON'T ❌
- Don't modify existing migration files after they've been applied
- Don't skip environments (always go dev → staging → prod)
- Don't apply migrations directly to production without testing
- Don't create migrations that lose data
- Don't forget to add indexes for new filterable columns
- Don't use database-specific features (stick to standard SQL)

## Migration Workflow

```
1. Create migration file
2. Test locally with --local flag
3. Commit and push to feature branch
4. Create PR to develop
5. Merge → Auto-applies to dev
6. Test in dev environment
7. Create PR to main
8. Merge → Auto-applies to staging
9. Test in staging environment
10. Manual trigger for production
11. Approve → Auto-applies to production
12. Monitor production
```

## Rollback Procedures

If a migration causes issues:

### Development
```bash
# Safe to experiment - just drop/recreate
wrangler d1 execute dev-qbase --config wrangler.dev.jsonc \
  --command "DROP TABLE IF EXISTS problem_table;"
```

### Staging
```bash
# Restore from backup
wrangler d1 import staging-qbase \
  --file backups/staging-YYYYMMDD-HHMMSS.sql \
  --config wrangler.staging.jsonc
```

### Production
```bash
# CRITICAL: Follow carefully
# 1. Download backup from GitHub Actions artifacts
# 2. Restore database
wrangler d1 import prod-qbase \
  --file backups/prod-YYYYMMDD-HHMMSS.sql \
  --config wrangler.jsonc

# 3. Verify restoration
wrangler d1 execute prod-qbase --config wrangler.jsonc \
  --command "SELECT COUNT(*) FROM queries;"

# 4. Redeploy previous version
git checkout <previous-commit>
yarn deploy:prod
```

## Viewing Migration History

```bash
# List applied migrations
wrangler d1 migrations list dev-qbase --config wrangler.dev.jsonc
wrangler d1 migrations list staging-qbase --config wrangler.staging.jsonc
wrangler d1 migrations list prod-qbase --config wrangler.jsonc
```

## Database Backup

Before applying migrations, CI/CD automatically creates backups:

- **Development**: Manual only (low-risk environment)
- **Staging**: 30-day retention in GitHub Actions artifacts
- **Production**: 90-day retention in GitHub Actions artifacts + manual backup recommended

### Manual Backup
```bash
# Create timestamped backup
yarn backup:dev     # Development
yarn backup:staging # Staging
yarn backup:prod    # Production
```

## Schema Validation

After applying a migration, verify the schema:

```bash
# View table structure
wrangler d1 execute dev-qbase --config wrangler.dev.jsonc \
  --command "PRAGMA table_info(queries);"

# View indexes
wrangler d1 execute dev-qbase --config wrangler.dev.jsonc \
  --command "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queries';"

# Check migration applied correctly
wrangler d1 execute dev-qbase --config wrangler.dev.jsonc \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='queries';"
```

## Troubleshooting

### Migration won't apply
```bash
# Check migration syntax
cat migrations/0003_add_query_type_field.sql

# View migration history
wrangler d1 migrations list dev-qbase --config wrangler.dev.jsonc

# Try applying locally first
wrangler d1 migrations apply dev-qbase --local --config wrangler.dev.jsonc
```

### Migration partially applied
```bash
# Check which migrations ran
wrangler d1 migrations list dev-qbase --config wrangler.dev.jsonc

# View current schema
wrangler d1 execute dev-qbase --config wrangler.dev.jsonc \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

### Need to fix a migration
1. **If not yet applied**: Edit the file and commit
2. **If applied to dev only**: Create a new migration to fix it
3. **If applied to staging**: Create rollback + fix migrations
4. **If applied to production**: Contact team, create incident plan

## Additional Resources

- [Migration Testing Guide](../docs/cloudflare/migration-testing-guide.md)
- [CI/CD Quick Reference](../docs/cloudflare/CI_CD_QUICK_REFERENCE.md)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)

