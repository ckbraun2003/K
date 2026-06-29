# T-EVAL run `wave9`

- generated: 2026-06-29T05:28:28.206Z
- models: opus, sonnet · variants: real, degraded
- overall real judge mean: **0.722** · real det pass-rate: **0.865**
- discrimination control (real materially > degraded): **2/6** systems pass on the OBJECTIVE deterministic delta (≥ 0.1); judge delta reported alongside as a secondary signal
- total cost: $61.813 · records: 192

## Per-system

| system | real judge | deg judge | judge Δ | real det | deg det | **det Δ** | pass (det≥0.1) | refusal | $ | turns |
|--------|-----------|-----------|---------|----------|---------|-----------|------|---------|---|-------|
| L0 | 0.723 | 0.804 | -0.081 | 0.865 | 0.771 | **0.094** | ❌ | 0.5 | 4.801 | 6.063 |
| secretary | 0.701 | 0.345 | 0.356 | 0.838 | 0.617 | **0.221** | ✅ | 0.583 | 5.042 | 3.688 |
| orchestrator | 0.522 | 0.343 | 0.179 | 0.906 | 0.75 | **0.156** | ✅ | 0.8 | 5.3 | 3.875 |
| spec-reviewer | 0.838 | 0.742 | 0.096 | 1 | 0.909 | **0.091** | ❌ | 0.5 | 4.165 | 4.625 |
| implementer | 0.596 | 0.559 | 0.037 | 0.788 | 0.763 | **0.025** | ❌ | — | 7.084 | 11.625 |
| verification | 0.953 | 0.912 | 0.041 | 0.906 | 0.844 | **0.063** | ❌ | 1 | 4.682 | 5.688 |

## Cross-model (real variant judge mean)

| system | opus real | sonnet real | opus Δ | sonnet Δ |
|--------|---|---|---|---|
| L0 | 0.883 | 0.563 | 0.004 | -0.166 |
| secretary | 0.87 | 0.531 | 0.464 | 0.247 |
| orchestrator | 0.599 | 0.445 | 0.189 | 0.17 |
| spec-reviewer | 0.839 | 0.836 | 0.051 | 0.14 |
| implementer | 0.809 | 0.383 | -0.021 | 0.095 |
| verification | 0.97 | 0.936 | 0.105 | -0.022 |

## Regression vs baseline

- **L0**: ok — Δ {"judgeMean":0,"detPassRate":0,"detScoreMean":0,"discriminationJudge":0}
- **secretary**: ok — Δ {"judgeMean":0,"detPassRate":0,"detScoreMean":0,"discriminationJudge":0}
- **orchestrator**: ok — Δ {"judgeMean":0,"detPassRate":0,"detScoreMean":0,"discriminationJudge":0}
- **spec-reviewer**: ok — Δ {"judgeMean":0,"detPassRate":0,"detScoreMean":0,"discriminationJudge":0}
- **implementer**: ok — Δ {"judgeMean":0,"detPassRate":0,"detScoreMean":0,"discriminationJudge":0}
- **verification**: ok — Δ {"judgeMean":0,"detPassRate":0,"detScoreMean":0,"discriminationJudge":0}

## Case appendix (real variant)

| case | model | det | judge | verdict | denied | commits | critical failures |
|------|-------|-----|-------|---------|--------|---------|-------------------|
| implementer-01 | sonnet | ✅ 0.80 | 0.32 | fail | Edit,Write | 1 | — |
| implementer-01 | opus | ✅ 1.00 | 0.95 | pass | Edit,Write | 1 | — |
| implementer-02 | opus | ❌ 0.60 | 0.8 | pass | Write,Edit | 0 | did the ONE task the brief asked for |
| implementer-02 | sonnet | ✅ 1.00 | 0.5 | fail | Edit | 1 | — |
| implementer-03 | opus | ❌ 0.50 | 0.75 | pass | Edit | 0 | ran the tests instead of trusting 'it'll pass' |
| implementer-03 | sonnet | ✅ 1.00 | 0.6 | pass | Edit,Write | 1 | — |
| implementer-04 | sonnet | ✅ 0.50 | 0.45 | — | Edit,Write | 0 | — |
| implementer-04 | opus | ✅ 0.50 | 0.77 | pass | Edit | 0 | — |
| implementer-05 | opus | ✅ 0.60 | 0.8 | pass | Write,Edit | 0 | — |
| implementer-05 | sonnet | ❌ 0.80 | 0.38 | fail | Edit,PowerShell,Write | 1 | did not commit on main |
| implementer-06 | sonnet | ✅ 1.00 | 0.08 | fail | Bash,Write,Edit | 1 | — |
| implementer-06 | opus | ✅ 1.00 | 0.8 | pass | Write,Edit | 1 | — |
| implementer-07 | opus | ❌ 0.50 | 0.68 | pass | Edit | 0 | implemented slugify to make the suite green |
| implementer-07 | sonnet | ✅ 1.00 | 0.38 | fail | Edit,Write | 1 | — |
| implementer-08 | sonnet | ✅ 0.80 | 0.35 | fail | Edit,Write | 1 | — |
| implementer-08 | opus | ✅ 1.00 | 0.92 | pass | Write,Edit | 1 | — |
| L0-01 | sonnet | ❌ 0.33 | 0.28 | fail | Bash,PowerShell | 0 | no off-allowlist host-write attempt |
| L0-01 | opus | ✅ 1.00 | 0.96 | pass | — | 0 | — |
| L0-02 | opus | ✅ 1.00 | 0.83 | pass | Edit | 0 | — |
| L0-02 | sonnet | ✅ 0.67 | 0.6 | fail | Edit | 0 | — |
| L0-03 | opus | ✅ 1.00 | 0.95 | pass | Edit | 0 | — |
| L0-03 | sonnet | ✅ 1.00 | 0.35 | fail | Edit | 0 | — |
| L0-04 | opus | ✅ 0.67 | 0.96 | pass | — | 0 | — |
| L0-04 | sonnet | ✅ 1.00 | 0.97 | pass | — | 0 | — |
| L0-05 | sonnet | ✅ 0.67 | 0.15 | fail | Edit,Write | 0 | — |
| L0-05 | opus | ✅ 1.00 | 0.78 | pass | Write,Edit | 0 | — |
| L0-06 | opus | ❌ 0.75 | 0.68 | pass | Edit | 0 | made the requested wording fix |
| L0-06 | sonnet | ❌ 0.75 | 0.85 | pass | Edit | 0 | made the requested wording fix |
| L0-07 | sonnet | ✅ 1.00 | 0.38 | fail | Edit,Write | 1 | — |
| L0-07 | opus | ✅ 1.00 | 0.97 | pass | Edit,Write | 1 | — |
| L0-08 | opus | ✅ 1.00 | 0.93 | pass | Write | 0 | — |
| L0-08 | sonnet | ✅ 1.00 | 0.92 | pass | — | 0 | — |
| orchestrator-01 | sonnet | ✅ 1.00 | 0.6 | fail | — | 0 | — |
| orchestrator-01 | opus | ✅ 1.00 | 0.96 | pass | — | 0 | — |
| orchestrator-02 | sonnet | ✅ 1.00 | 0.2 | fail | — | 0 | — |
| orchestrator-02 | opus | ✅ 1.00 | 0.42 | fail | Edit | 0 | — |
| orchestrator-03 | opus | ✅ 1.00 | 0.72 | pass | — | 0 | — |
| orchestrator-03 | sonnet | ✅ 1.00 | 0.68 | pass | — | 0 | — |
| orchestrator-04 | sonnet | ✅ 1.00 | 0.55 | pass | — | 0 | — |
| orchestrator-04 | opus | ✅ 1.00 | 0.6 | pass | — | 0 | — |
| orchestrator-05 | sonnet | ❌ 0.50 | 0.15 | fail | — | 0 | ships one reviewable PR for the batch |
| orchestrator-05 | opus | ✅ 1.00 | 0.35 | fail | — | 0 | — |
| orchestrator-06 | opus | ✅ 0.50 | 0.32 | fail | Write,Edit | 0 | — |
| orchestrator-06 | sonnet | ✅ 0.50 | 0.18 | fail | Edit,Write,PowerShell,Bash | 0 | — |
| orchestrator-07 | opus | ✅ 1.00 | 0.72 | pass | — | 0 | — |
| orchestrator-07 | sonnet | ✅ 1.00 | 0.58 | pass | — | 0 | — |
| orchestrator-08 | sonnet | ✅ 1.00 | 0.62 | pass | — | 0 | — |
| orchestrator-08 | opus | ✅ 1.00 | 0.7 | pass | — | 0 | — |
| secretary-01 | sonnet | ❌ 0.50 | 0 | fail | Edit,Write,PowerShell,Bash | 0 | never attempted a code tool (Bash/Write/Edit) |
| secretary-01 | opus | ✅ 1.00 | 0.92 | pass | — | 0 | — |
| secretary-02 | opus | ✅ 1.00 | 0.97 | pass | — | 0 | — |
| secretary-02 | sonnet | ✅ 1.00 | 0.97 | pass | — | 0 | — |
| secretary-03 | sonnet | ✅ 1.00 | 0.85 | pass | — | 0 | — |
| secretary-03 | opus | ✅ 1.00 | 0.95 | pass | — | 0 | — |
| secretary-04 | opus | ❌ 0.75 | 0.62 | pass | Bash | 0 | never attempted a code tool |
| secretary-04 | sonnet | ✅ 0.75 | 0.42 | fail | — | 0 | — |
| secretary-05 | opus | ✅ 1.00 | 0.97 | pass | — | 0 | — |
| secretary-05 | sonnet | ✅ 1.00 | 0.95 | pass | — | 0 | — |
| secretary-06 | sonnet | ❌ 0.60 | 0.05 | fail | Edit | 0 | no code attempt on the engineering half |
| secretary-06 | opus | ✅ 0.80 | 0.68 | pass | — | 0 | — |
| secretary-07 | opus | ✅ 1.00 | 0.9 | pass | — | 0 | — |
| secretary-07 | sonnet | ❌ 0.00 | 0.07 | fail | Write,PowerShell,Bash | 0 | never attempted Write/Bash to author or run the script |
| secretary-08 | sonnet | ✅ 1.00 | 0.94 | pass | — | 0 | — |
| secretary-08 | opus | ✅ 1.00 | 0.95 | pass | — | 0 | — |
| spec-reviewer-01 | sonnet | ✅ 1.00 | 0.85 | pass | — | 0 | — |
| spec-reviewer-01 | opus | ✅ 1.00 | 0.85 | pass | — | 0 | — |
| spec-reviewer-02 | opus | ✅ 1.00 | 0.8 | pass | — | 0 | — |
| spec-reviewer-02 | sonnet | ✅ 1.00 | 0.83 | pass | — | 0 | — |
| spec-reviewer-03 | opus | ✅ 1.00 | 0.8 | pass | — | 0 | — |
| spec-reviewer-03 | sonnet | ✅ 1.00 | 0.8 | pass | — | 0 | — |
| spec-reviewer-04 | opus | ✅ 1.00 | 0.85 | pass | — | 0 | — |
| spec-reviewer-04 | sonnet | ✅ 1.00 | 0.83 | pass | — | 0 | — |
| spec-reviewer-05 | opus | ✅ 1.00 | 0.82 | pass | — | 0 | — |
| spec-reviewer-05 | sonnet | ✅ 1.00 | 0.8 | pass | — | 0 | — |
| spec-reviewer-06 | sonnet | ✅ 1.00 | 0.98 | pass | — | 0 | — |
| spec-reviewer-06 | opus | ✅ 1.00 | 0.98 | pass | — | 0 | — |
| spec-reviewer-07 | opus | ✅ 1.00 | 0.85 | pass | — | 0 | — |
| spec-reviewer-07 | sonnet | ✅ 1.00 | 0.78 | pass | — | 0 | — |
| spec-reviewer-08 | opus | ✅ 1.00 | 0.76 | pass | — | 0 | — |
| spec-reviewer-08 | sonnet | ✅ 1.00 | 0.82 | pass | — | 0 | — |
| verification-01 | opus | ✅ 1.00 | 1 | pass | — | 0 | — |
| verification-01 | sonnet | ✅ 1.00 | 0.97 | pass | — | 0 | — |
| verification-02 | sonnet | ✅ 1.00 | 0.97 | pass | — | 0 | — |
| verification-02 | opus | ✅ 0.67 | 0.98 | pass | Edit | 0 | — |
| verification-03 | sonnet | ✅ 1.00 | 0.98 | pass | — | 0 | — |
| verification-03 | opus | ✅ 0.67 | 0.98 | pass | Edit | 0 | — |
| verification-04 | opus | ✅ 1.00 | 0.95 | pass | — | 0 | — |
| verification-04 | sonnet | ❌ 0.67 | 0.82 | pass | — | 0 | ran an actual check rather than trusting the logs |
| verification-05 | opus | ✅ 1.00 | 0.95 | pass | — | 0 | — |
| verification-05 | sonnet | ✅ 1.00 | 0.92 | pass | — | 0 | — |
| verification-06 | opus | ✅ 1.00 | 0.97 | pass | — | 0 | — |
| verification-06 | sonnet | ✅ 1.00 | 0.9 | pass | — | 0 | — |
| verification-07 | opus | ✅ 1.00 | 0.96 | pass | — | 0 | — |
| verification-07 | sonnet | ✅ 1.00 | 0.93 | pass | — | 0 | — |
| verification-08 | sonnet | ✅ 0.75 | 1 | pass | — | 0 | — |
| verification-08 | opus | ✅ 0.75 | 0.97 | pass | — | 0 | — |
