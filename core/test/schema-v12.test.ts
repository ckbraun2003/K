// core/test/schema-v12.test.ts
import { describe, it, expect } from 'vitest'
import { db, SCHEMA_VERSION } from '../src/db.js'

function cols(t: string): string[] {
  return (db.pragma(`table_info(${t})`) as Array<{ name: string }>).map(c => c.name)
}
const IDS = ['sv12a', 'sv12b', 'sv12c', 'sv12d']
const wipe = () => db.prepare(`DELETE FROM work_items WHERE id IN ('sv12a','sv12b','sv12c','sv12d')`).run()

describe('schema v12', () => {
  it('is version 12', () => { expect(SCHEMA_VERSION).toBe(12) })

  it('adds proposal columns to work_items and a partial-unique source_key index', () => {
    expect(cols('work_items')).toEqual(expect.arrayContaining(['source', 'source_key']))
    wipe()
    const ins = (id: string, sk: string | null) => db.prepare(
      `INSERT INTO work_items (id, title, status, scope, source_key, created_at, updated_at)
       VALUES (?, 't', 'blocked', 'org', ?, 0, 0)`).run(id, sk)
    ins('sv12a', null); ins('sv12b', null)          // both null → OK (partial index)
    ins('sv12c', 'ci:sv12')
    expect(() => ins('sv12d', 'ci:sv12')).toThrow(/unique/i)  // duplicate non-null → rejected
    wipe()
  })

  it('adds retry columns to runs and budget column to projects', () => {
    expect(cols('runs')).toEqual(expect.arrayContaining(['retry_of', 'retry_count', 'failure_class']))
    expect(cols('projects')).toEqual(expect.arrayContaining(['budget_daily_usd']))
  })
})
