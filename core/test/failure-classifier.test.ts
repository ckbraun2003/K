import { describe, it, expect } from 'vitest'
import { classifyFailure, fallbackModel, isRetryable } from '../src/failure-classifier.js'

describe('failure classifier', () => {
  it('classifies transient network/5xx patterns', () => {
    expect(classifyFailure({ status: 'error', stderr: 'Error: getaddrinfo ENOTFOUND api' })).toBe('transient')
    expect(classifyFailure({ status: 'error', stderr: 'HTTP 529 overloaded_error' })).toBe('model_capacity')
    expect(classifyFailure({ status: 'error', stderr: 'connection reset by peer' })).toBe('transient')
  })
  it('classifies timeouts and tooling and permanent', () => {
    expect(classifyFailure({ status: 'error', stderr: 'operation timed out after 600s' })).toBe('timeout')
    expect(classifyFailure({ status: 'error', stderr: 'command not found: pytest' })).toBe('tooling')
    expect(classifyFailure({ status: 'error', stderr: 'AssertionError: expected 1 to equal 2' })).toBe('permanent')
    expect(classifyFailure({ status: 'killed' })).toBe('permanent')  // operator kill is not auto-retried
    expect(classifyFailure({ status: 'error', stderr: null })).toBe('unknown')
  })
  it('classifies a permanent failure permanent even when its message carries a transient token', () => {
    // The stray "429" matches the model_capacity pattern as a substring; because `permanent`
    // is tested FIRST, the genuine assertion failure wins and is NOT wrongly auto-retried.
    expect(classifyFailure({ status: 'error', stderr: 'AssertionError: expected 429 to equal 200' })).toBe('permanent')
    expect(isRetryable(classifyFailure({ status: 'error', stderr: 'AssertionError: expected 429 to equal 200' }))).toBe(false)
  })
  it('fallback downgrades on capacity, keeps model on transient, none on permanent', () => {
    expect(fallbackModel('claude-opus-4-8', 'model_capacity')).toBe('claude-sonnet-4-6')
    expect(fallbackModel('claude-sonnet-4-6', 'transient')).toBe('claude-sonnet-4-6') // retry same model
    expect(fallbackModel('claude-sonnet-4-6', 'permanent')).toBeNull()
    expect(isRetryable('permanent')).toBe(false)
    expect(isRetryable('transient')).toBe(true)
  })
})
