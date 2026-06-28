# Findings reports

One file per suite: `S<n>-<name>.md`. Each is a table of replicated concerns using the campaign
finding schema (see `../README.md`). A concern appears here **only after a validator independently
reproduces it** — the prober + validator are both named on the row.

`LOCK` rows link to a passing test in the gating suite; `FAULT` rows link to a red test in
`core/test/regressions/**` or `web/test/regressions/**`. Counts roll up into `../ledger.md`.
